import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const isVercel = process.env.VERCEL === "1";
const DEFAULT_DATA_DIR = path.join(__dirname, "..", "data");
const DATA_DIR = isVercel
  ? "/tmp/data"
  : process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : DEFAULT_DATA_DIR;

// Ensure data directory exists on startup
if (!fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    console.warn(`Warning: Could not create data directory at ${DATA_DIR}:`, err);
  }
}

// Copy seed files to /tmp/data on Vercel so they are writable
if (isVercel && DATA_DIR === "/tmp/data") {
  try {
    if (fs.existsSync(DEFAULT_DATA_DIR)) {
      const files = fs.readdirSync(DEFAULT_DATA_DIR);
      for (const file of files) {
        const srcPath = path.join(DEFAULT_DATA_DIR, file);
        const destPath = path.join(DATA_DIR, file);
        if (fs.statSync(srcPath).isFile() && !fs.existsSync(destPath)) {
          fs.copyFileSync(srcPath, destPath);
        }
      }
    }
  } catch (err) {
    console.warn("Warning: Could not seed data to /tmp/data:", err);
  }
}

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

const cache = new Map<string, any[]>();

// ---------------------------------------------------------------------------
// File I/O helpers
// ---------------------------------------------------------------------------

function filePath(collection: string): string {
  return path.join(DATA_DIR, `${collection}.json`);
}

function readCollection(collection: string): any[] {
  if (cache.has(collection)) return cache.get(collection)!;
  const fp = filePath(collection);
  if (!fs.existsSync(fp)) {
    cache.set(collection, []);
    return [];
  }
  try {
    const raw = fs.readFileSync(fp, "utf-8");
    const parsed = JSON.parse(raw) as any[];
    cache.set(collection, parsed);
    return parsed;
  } catch {
    cache.set(collection, []);
    return [];
  }
}

function writeCollection(collection: string, data: any[]): void {
  cache.set(collection, data);
  const fp = filePath(collection);
  const tmp = fp + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, fp);
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

type Filter = Record<string, any>;

function matchesFilter(doc: any, filter: Filter): boolean {
  for (const [key, value] of Object.entries(filter)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      // Mongo-style operators
      if ("$gt" in value) {
        const docVal = doc[key];
        const cmpVal = value.$gt;
        if (docVal === undefined || docVal === null) return false;
        const d = docVal instanceof Date ? docVal : new Date(docVal);
        const c = cmpVal instanceof Date ? cmpVal : new Date(cmpVal);
        if (isNaN(c.getTime())) { if (docVal <= cmpVal) return false; }
        else { if (d <= c) return false; }
        continue;
      }
      if ("$gte" in value) {
        const docVal = doc[key];
        const cmpVal = value.$gte;
        if (docVal === undefined || docVal === null) return false;
        const d = docVal instanceof Date ? docVal : new Date(docVal);
        const c = cmpVal instanceof Date ? cmpVal : new Date(cmpVal);
        if (isNaN(c.getTime())) { if (docVal < cmpVal) return false; }
        else { if (d < c) return false; }
        continue;
      }
      if ("$lt" in value) {
        const docVal = doc[key];
        const cmpVal = value.$lt;
        if (docVal === undefined || docVal === null) return false;
        const d = docVal instanceof Date ? docVal : new Date(docVal);
        const c = cmpVal instanceof Date ? cmpVal : new Date(cmpVal);
        if (isNaN(c.getTime())) { if (docVal >= cmpVal) return false; }
        else { if (d >= c) return false; }
        continue;
      }
      if ("$regex" in value) {
        const docVal = doc[key];
        if (typeof docVal !== "string") return false;
        const flags = value.$options || "";
        const re = new RegExp(value.$regex, flags);
        if (!re.test(docVal)) return false;
        continue;
      }
      if ("$in" in value) {
        if (!value.$in.includes(doc[key])) return false;
        continue;
      }
      if ("$ne" in value) {
        if (doc[key] === value.$ne) return false;
        continue;
      }
    }
    // Equality
    if (doc[key] !== value) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Collection class
// ---------------------------------------------------------------------------

export class Collection {
  constructor(private name: string) {}

  /** Generate a new unique ID */
  static newId(): string {
    return randomUUID();
  }

  findMany(filter: Filter = {}, options: { sort?: Record<string, 1 | -1>; limit?: number } = {}): any[] {
    let docs = readCollection(this.name).filter((d) => matchesFilter(d, filter));
    if (options.sort) {
      const [sortKey, sortDir] = Object.entries(options.sort)[0];
      docs = docs.sort((a, b) => {
        const av = a[sortKey];
        const bv = b[sortKey];
        if (av == null && bv == null) return 0;
        if (av == null) return sortDir === 1 ? -1 : 1;
        if (bv == null) return sortDir === 1 ? 1 : -1;
        const aDate = av instanceof Date ? av.getTime() : typeof av === "string" && isNaN(Number(av)) ? new Date(av).getTime() : Number(av);
        const bDate = bv instanceof Date ? bv.getTime() : typeof bv === "string" && isNaN(Number(bv)) ? new Date(bv).getTime() : Number(bv);
        if (!isNaN(aDate) && !isNaN(bDate)) return sortDir === 1 ? aDate - bDate : bDate - aDate;
        const aStr = String(av);
        const bStr = String(bv);
        return sortDir === 1 ? aStr.localeCompare(bStr) : bStr.localeCompare(aStr);
      });
    }
    if (options.limit) docs = docs.slice(0, options.limit);
    return docs;
  }

  findOne(filter: Filter = {}): any | null {
    return readCollection(this.name).find((d) => matchesFilter(d, filter)) ?? null;
  }

  insertOne(doc: any): { insertedId: string } {
    const data = readCollection(this.name);
    const id = doc.id || Collection.newId();
    const newDoc = { ...doc, id };
    data.push(newDoc);
    writeCollection(this.name, data);
    return { insertedId: id };
  }

  insertMany(docs: any[]): { insertedIds: string[] } {
    const data = readCollection(this.name);
    const insertedIds: string[] = [];
    for (const doc of docs) {
      const id = doc.id || Collection.newId();
      data.push({ ...doc, id });
      insertedIds.push(id);
    }
    writeCollection(this.name, data);
    return { insertedIds };
  }

  updateOne(filter: Filter, update: { $set?: Record<string, any>; $unset?: Record<string, any> }): { matchedCount: number; modifiedCount: number } {
    const data = readCollection(this.name);
    const idx = data.findIndex((d) => matchesFilter(d, filter));
    if (idx === -1) return { matchedCount: 0, modifiedCount: 0 };
    if (update.$set) Object.assign(data[idx], update.$set);
    if (update.$unset) {
      for (const key of Object.keys(update.$unset)) {
        delete data[idx][key];
      }
    }
    writeCollection(this.name, data);
    return { matchedCount: 1, modifiedCount: 1 };
  }

  updateMany(filter: Filter, update: { $set?: Record<string, any>; $unset?: Record<string, any> }): { matchedCount: number; modifiedCount: number } {
    const data = readCollection(this.name);
    let count = 0;
    for (let i = 0; i < data.length; i++) {
      if (matchesFilter(data[i], filter)) {
        if (update.$set) Object.assign(data[i], update.$set);
        if (update.$unset) {
          for (const key of Object.keys(update.$unset)) {
            delete data[i][key];
          }
        }
        count++;
      }
    }
    if (count > 0) writeCollection(this.name, data);
    return { matchedCount: count, modifiedCount: count };
  }

  deleteOne(filter: Filter): { deletedCount: number } {
    const data = readCollection(this.name);
    const idx = data.findIndex((d) => matchesFilter(d, filter));
    if (idx === -1) return { deletedCount: 0 };
    data.splice(idx, 1);
    writeCollection(this.name, data);
    return { deletedCount: 1 };
  }

  deleteMany(filter: Filter): { deletedCount: number } {
    const data = readCollection(this.name);
    const before = data.length;
    const filtered = data.filter((d) => !matchesFilter(d, filter));
    writeCollection(this.name, filtered);
    return { deletedCount: before - filtered.length };
  }

  /** Count documents matching a filter */
  countDocuments(filter: Filter = {}): number {
    return readCollection(this.name).filter((d) => matchesFilter(d, filter)).length;
  }

  /** Replace entire document */
  replaceOne(filter: Filter, replacement: any): { matchedCount: number; modifiedCount: number } {
    const data = readCollection(this.name);
    const idx = data.findIndex((d) => matchesFilter(d, filter));
    if (idx === -1) return { matchedCount: 0, modifiedCount: 0 };
    const id = data[idx].id;
    data[idx] = { ...replacement, id };
    writeCollection(this.name, data);
    return { matchedCount: 1, modifiedCount: 1 };
  }

  /** Get all data (for debugging / export) */
  all(): any[] {
    return readCollection(this.name);
  }
}

// ---------------------------------------------------------------------------
// DB facade — returns collection by name
// ---------------------------------------------------------------------------

const collections = new Map<string, Collection>();

export function getCollection(name: string): Collection {
  if (!collections.has(name)) {
    collections.set(name, new Collection(name));
  }
  return collections.get(name)!;
}

// ---------------------------------------------------------------------------
// Control DB adapter — mirrors the MongoDB getControlDb() API surface
// ---------------------------------------------------------------------------

export interface JsonDb {
  collection: (name: string) => Collection;
}

let _db: JsonDb | null = null;

export async function getControlDb(): Promise<JsonDb> {
  if (_db) return _db;
  _db = {
    collection: (name: string) => getCollection(name),
  };
  return _db;
}

// ---------------------------------------------------------------------------
// Helper: new unique ID (for use wherever ObjectId was used)
// ---------------------------------------------------------------------------

export function newId(): string {
  return randomUUID();
}

export { DATA_DIR };
