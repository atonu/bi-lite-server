import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { AsyncLocalStorage } from "async_hooks";
import { MongoClient } from "mongodb";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const isVercel = process.env.VERCEL === "1";
const DEFAULT_DATA_DIR = path.join(__dirname, "..", "data");
const DATA_DIR = isVercel
  ? "/tmp/storage"
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

// Recursive Copy helper for Vercel Seeding
function copyRecursiveSync(src: string, dest: string) {
  const exists = fs.existsSync(src);
  const stats = exists && fs.statSync(src);
  const isDirectory = stats && stats.isDirectory();
  if (isDirectory) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    fs.readdirSync(src).forEach((childItemName) => {
      copyRecursiveSync(path.join(src, childItemName), path.join(dest, childItemName));
    });
  } else {
    if (!fs.existsSync(dest)) {
      fs.copyFileSync(src, dest);
    }
  }
}

// Copy seed files to /tmp/storage on Vercel so they are writable
if (isVercel && DATA_DIR === "/tmp/storage") {
  try {
    if (fs.existsSync(DEFAULT_DATA_DIR)) {
      copyRecursiveSync(DEFAULT_DATA_DIR, DATA_DIR);
    }
  } catch (err) {
    console.warn("Warning: Could not seed data to /tmp/storage:", err);
  }
}

// ---------------------------------------------------------------------------
// MongoDB Persistence Engine for Vercel
// ---------------------------------------------------------------------------
const mongoUri = process.env.MONGODB_URI || "";
let mongoClient: MongoClient | null = null;

async function getMongoClientInstance(): Promise<MongoClient> {
  if (mongoClient) return mongoClient;
  try {
    mongoClient = new MongoClient(mongoUri);
    await mongoClient.connect();
    return mongoClient;
  } catch (err) {
    console.error(`[json-db] Failed to connect to MongoDB at ${mongoUri}:`, err);
    throw err;
  }
}

// Background sync queue to ensure sequential uploads per collection/user
const syncQueue = new Map<string, Promise<void>>();

function queueMongoSync(collection: string, data: any[], userId: string | null): void {
  const syncKey = `${collection}::${userId || "system"}`;
  const currentPromise = syncQueue.get(syncKey) || Promise.resolve();

  const nextPromise = currentPromise.then(async () => {
    try {
      const client = await getMongoClientInstance();
      const db = client.db();
      const col = db.collection(collection);

      if (SYSTEM_COLLECTIONS.includes(collection) || collection === "mappings") {
        // Clear all and insert new
        await col.deleteMany({});
        if (data.length > 0) {
          await col.insertMany(data);
        }
      } else {
        const uId = userId || "default";
        // Clear for this user and insert new
        await col.deleteMany({ userId: uId });
        if (data.length > 0) {
          const docs = data.map((d) => ({ ...d, userId: uId }));
          await col.insertMany(docs);
        }
      }
    } catch (err) {
      console.error(`[json-db] Mongo background sync failed for key ${syncKey}:`, err);
    }
  });

  syncQueue.set(syncKey, nextPromise);
  nextPromise.finally(() => {
    if (syncQueue.get(syncKey) === nextPromise) {
      syncQueue.delete(syncKey);
    }
  });
}

async function syncFromMongoOnStartup(): Promise<void> {
  try {
    console.log("[json-db] Vercel environment detected. Pre-populating local /tmp/storage from MongoDB...");
    const client = await getMongoClientInstance();
    const db = client.db();

    const collectionsToSync = [
      "users", "prospect_users", "organizations", "mappings",
      "database_connections", "query_jobs", "query_job_results",
      "user_templates", "chat_sessions", "chat_messages", "schema_metadata"
    ];

    for (const name of collectionsToSync) {
      const collections = await db.listCollections({ name }).toArray();
      if (collections.length === 0) continue;

      const docs = await db.collection(name).find({}).toArray();
      const cleanDocs = docs.map((doc: any) => {
        const { _id, ...rest } = doc;
        const id = rest.id || _id.toString();
        return { id, ...rest };
      });

      if (SYSTEM_COLLECTIONS.includes(name) || name === "mappings") {
        const fp = getCollectionPath(name, "");
        let dataToSave: any = cleanDocs;
        if (name === "mappings") {
          dataToSave = cleanDocs.length > 0 ? cleanDocs[0] : { connections: {}, jobs: {}, sessions: {} };
        }
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, JSON.stringify(dataToSave, null, 2), "utf-8");
        cache.set(fp, dataToSave);
      } else {
        // Group by userId
        const userGroups = new Map<string, any[]>();
        for (const doc of cleanDocs) {
          const uId = doc.userId || "default";
          if (!userGroups.has(uId)) {
            userGroups.set(uId, []);
          }
          const { userId, ...originalDoc } = doc;
          userGroups.get(uId)!.push(originalDoc);
        }

        // Save each group
        for (const [uId, userDocs] of userGroups.entries()) {
          const fp = getCollectionPath(name, uId);
          fs.mkdirSync(path.dirname(fp), { recursive: true });
          fs.writeFileSync(fp, JSON.stringify(userDocs, null, 2), "utf-8");
          cache.set(fp, userDocs);
        }
      }
    }
    console.log("[json-db] Local /tmp/storage pre-population from MongoDB complete.");
  } catch (err) {
    console.error("[json-db] Failed to pre-populate local storage from MongoDB on startup:", err);
  }
}

export async function waitForPendingMongoSyncs(): Promise<void> {
  while (syncQueue.size > 0) {
    const promises = Array.from(syncQueue.values());
    await Promise.allSettled(promises);
    // Yield control to the event loop so that background queue deletion microtasks have a chance to execute
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// Run default database migration (skip initial run on Vercel as we need to populate from MongoDB first)
if (!isVercel) {
  migrateDefaultUserData();
}


// ---------------------------------------------------------------------------
// User Context Storage (propagates context across async callbacks)
// ---------------------------------------------------------------------------
export const userContextStorage = new AsyncLocalStorage<{ userId?: string; organizationId?: string }>();

// ---------------------------------------------------------------------------
// System Mappings Helpers
// ---------------------------------------------------------------------------
interface Mappings {
  connections: Record<string, string>;
  jobs: Record<string, string>;
  sessions: Record<string, string>;
}

function readMappings(): Mappings {
  const filePath = path.join(DATA_DIR, "system", "mappings.json");
  if (!fs.existsSync(filePath)) {
    return { connections: {}, jobs: {}, sessions: {} };
  }
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as Mappings;
  } catch {
    return { connections: {}, jobs: {}, sessions: {} };
  }
}

function writeMappings(mappings: Mappings): void {
  const filePath = path.join(DATA_DIR, "system", "mappings.json");
  const dirPath = path.dirname(filePath);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(mappings, null, 2), "utf-8");
  fs.renameSync(tmp, filePath);

  if (isVercel) {
    queueMongoSync("mappings", [mappings], null);
  }
}

function updateMapping(type: "connections" | "jobs" | "sessions", id: string, userId: string): void {
  try {
    const mappings = readMappings();
    mappings[type][id] = userId;
    writeMappings(mappings);
  } catch (err) {
    console.warn(`[json-db] Failed to write mapping for ${type} id ${id}:`, err);
  }
}

function migrateDefaultUserData() {
  try {
    const defaultDir = path.join(DATA_DIR, "userdata", "default");
    if (!fs.existsSync(defaultDir)) return;

    console.log("[json-db] Found default user data, starting automatic migration...");

    const usersFile = path.join(DATA_DIR, "system", "users.json");
    if (!fs.existsSync(usersFile)) {
      console.log("[json-db] users.json not found, skipping migration.");
      return;
    }

    const users = JSON.parse(fs.readFileSync(usersFile, "utf-8")) as any[];

    // Map organization_id -> userId
    const orgToUser = new Map<string, string>();
    for (const u of users) {
      if (u.id && u.organization_id) {
        orgToUser.set(u.organization_id, u.id);
      }
    }

    // 1. Migrate connections
    const defaultConnsPath = path.join(defaultDir, "database_connections.json");
    const connectionOwnerMap = new Map<string, string>(); // connectionId -> userId

    if (fs.existsSync(defaultConnsPath)) {
      const connections = JSON.parse(fs.readFileSync(defaultConnsPath, "utf-8")) as any[];
      for (const conn of connections) {
        const userId = orgToUser.get(conn.organization_id) || "default";
        if (userId !== "default") {
          connectionOwnerMap.set(conn.id, userId);
          // Save to user folder
          const userConnsPath = path.join(DATA_DIR, "userdata", userId, "database_connections.json");
          const userConnsDir = path.dirname(userConnsPath);
          if (!fs.existsSync(userConnsDir)) {
            fs.mkdirSync(userConnsDir, { recursive: true });
          }
          const userConns = fs.existsSync(userConnsPath)
            ? JSON.parse(fs.readFileSync(userConnsPath, "utf-8"))
            : [];
          if (!userConns.some((c: any) => c.id === conn.id)) {
            userConns.push(conn);
            fs.writeFileSync(userConnsPath, JSON.stringify(userConns, null, 2), "utf-8");
          }
          // Register mapping
          updateMapping("connections", conn.id, userId);
        }
      }
      fs.unlinkSync(defaultConnsPath);
    }

    // 2. Migrate schema metadata
    const defaultMetaPath = path.join(defaultDir, "schema_metadata.json");
    if (fs.existsSync(defaultMetaPath)) {
      const metadata = JSON.parse(fs.readFileSync(defaultMetaPath, "utf-8")) as any[];
      for (const meta of metadata) {
        const userId = connectionOwnerMap.get(meta.connection_id) || "default";
        if (userId !== "default") {
          const userMetaPath = path.join(DATA_DIR, "userdata", userId, "schema_metadata.json");
          const userMetaDir = path.dirname(userMetaPath);
          if (!fs.existsSync(userMetaDir)) {
            fs.mkdirSync(userMetaDir, { recursive: true });
          }
          const userMeta = fs.existsSync(userMetaPath)
            ? JSON.parse(fs.readFileSync(userMetaPath, "utf-8"))
            : [];
          if (!userMeta.some((m: any) => m.id === meta.id)) {
            userMeta.push(meta);
            fs.writeFileSync(userMetaPath, JSON.stringify(userMeta, null, 2), "utf-8");
          }
        }
      }
      fs.unlinkSync(defaultMetaPath);
    }

    // 3. Migrate query jobs
    const defaultJobsPath = path.join(defaultDir, "query_jobs.json");
    if (fs.existsSync(defaultJobsPath)) {
      const jobs = JSON.parse(fs.readFileSync(defaultJobsPath, "utf-8")) as any[];
      for (const job of jobs) {
        const userId = orgToUser.get(job.organizationId) || "default";
        if (userId !== "default") {
          const userJobsPath = path.join(DATA_DIR, "userdata", userId, "query_jobs.json");
          const userJobsDir = path.dirname(userJobsPath);
          if (!fs.existsSync(userJobsDir)) {
            fs.mkdirSync(userJobsDir, { recursive: true });
          }
          const userJobs = fs.existsSync(userJobsPath)
            ? JSON.parse(fs.readFileSync(userJobsPath, "utf-8"))
            : [];
          if (!userJobs.some((j: any) => j.id === job.id)) {
            userJobs.push(job);
            fs.writeFileSync(userJobsPath, JSON.stringify(userJobs, null, 2), "utf-8");
          }
          updateMapping("jobs", job.id, userId);
        }
      }
      fs.unlinkSync(defaultJobsPath);
    }

    // 4. Migrate query job results
    const defaultResultsPath = path.join(defaultDir, "query_job_results.json");
    if (fs.existsSync(defaultResultsPath)) {
      const results = JSON.parse(fs.readFileSync(defaultResultsPath, "utf-8")) as any[];
      for (const res of results) {
        const mappings = readMappings();
        const userId = mappings.jobs[res.jobId] || "default";
        if (userId !== "default") {
          const userResultsPath = path.join(DATA_DIR, "userdata", userId, "query_job_results.json");
          const userResultsDir = path.dirname(userResultsPath);
          if (!fs.existsSync(userResultsDir)) {
            fs.mkdirSync(userResultsDir, { recursive: true });
          }
          const userResults = fs.existsSync(userResultsPath)
            ? JSON.parse(fs.readFileSync(userResultsPath, "utf-8"))
            : [];
          if (!userResults.some((r: any) => r.id === res.id)) {
            userResults.push(res);
            fs.writeFileSync(userResultsPath, JSON.stringify(userResults, null, 2), "utf-8");
          }
        }
      }
      fs.unlinkSync(defaultResultsPath);
    }

    // Clean up default directory if empty
    const files = fs.readdirSync(defaultDir);
    if (files.length === 0) {
      fs.rmdirSync(defaultDir);
      console.log("[json-db] Default user data successfully migrated.");
    } else {
      console.log(`[json-db] Default folder contains remaining files: ${files.join(", ")}, keeping folder.`);
    }

  } catch (err) {
    console.error("[json-db] Error during automatic default data migration:", err);
  }
}


// ---------------------------------------------------------------------------
// Path Resolution
// ---------------------------------------------------------------------------
const SYSTEM_COLLECTIONS = ["users", "prospect_users", "organizations"];

function resolveUserId(collection: string, filter?: any, doc?: any): string {
  // 1. Try to get from AsyncLocalStorage context
  const context = userContextStorage.getStore();
  console.log(`[json-db] resolveUserId: collection = ${collection}, context = ${JSON.stringify(context)}, filter = ${JSON.stringify(filter)}`);
  if (context?.userId) {
    return context.userId;
  }

  // 2. Try to extract from filter / document directly
  const sources = [filter, doc, doc?.$set, doc?.$setOnInsert].filter(Boolean);
  for (const src of sources) {
    if (src.userId) return String(src.userId);
    if (src.user_id) return String(src.user_id);
  }

  // 3. Try to resolve via global system mappings
  const mappings = readMappings();

  // Check connection ID
  for (const src of sources) {
    if (src.connectionId && mappings.connections[src.connectionId]) {
      return mappings.connections[src.connectionId];
    }
    if (src.connection_id && mappings.connections[src.connection_id]) {
      return mappings.connections[src.connection_id];
    }
    if (collection === "database_connections" && src.id && mappings.connections[src.id]) {
      return mappings.connections[src.id];
    }
  }

  // Check job ID
  for (const src of sources) {
    if (src.jobId && mappings.jobs[src.jobId]) {
      return mappings.jobs[src.jobId];
    }
    if (src.job_id && mappings.jobs[src.job_id]) {
      return mappings.jobs[src.job_id];
    }
    if (collection === "query_jobs" && src.id && mappings.jobs[src.id]) {
      return mappings.jobs[src.id];
    }
    if (collection === "query_job_results" && src.id && mappings.jobs[src.id]) {
      return mappings.jobs[src.id];
    }
    // query_job_results has jobId parameter
    if (src.jobId && mappings.jobs[src.jobId]) {
      return mappings.jobs[src.jobId];
    }
  }

  // Check session ID
  for (const src of sources) {
    if (src.sessionId && mappings.sessions[src.sessionId]) {
      return mappings.sessions[src.sessionId];
    }
    if (src.session_id && mappings.sessions[src.session_id]) {
      return mappings.sessions[src.session_id];
    }
    if (collection === "chat_sessions" && src.id && mappings.sessions[src.id]) {
      return mappings.sessions[src.id];
    }
  }

  // 4. Fallback scans on filter properties
  if (filter && typeof filter === "object") {
    for (const val of Object.values(filter)) {
      if (typeof val === "string") {
        if (mappings.connections[val]) return mappings.connections[val];
        if (mappings.jobs[val]) return mappings.jobs[val];
        if (mappings.sessions[val]) return mappings.sessions[val];
      }
    }
  }

  return "default";
}

function getCollectionPath(collection: string, userId: string): string {
  if (SYSTEM_COLLECTIONS.includes(collection)) {
    return path.join(DATA_DIR, "system", `${collection}.json`);
  }
  return path.join(DATA_DIR, "userdata", userId, `${collection}.json`);
}

// ---------------------------------------------------------------------------
// In-memory Cache & Atomic Write System
// ---------------------------------------------------------------------------
const cache = new Map<string, any>();

function readCollection(collection: string, userId: string): any[] {
  const fp = getCollectionPath(collection, userId);
  if (cache.has(fp)) return cache.get(fp)!;
  if (!fs.existsSync(fp)) {
    cache.set(fp, []);
    return [];
  }
  try {
    const raw = fs.readFileSync(fp, "utf-8");
    const parsed = JSON.parse(raw) as any[];
    cache.set(fp, parsed);
    return parsed;
  } catch {
    cache.set(fp, []);
    return [];
  }
}

function writeCollection(collection: string, data: any[], userId: string): void {
  const fp = getCollectionPath(collection, userId);
  cache.set(fp, data);
  const dirPath = path.dirname(fp);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  const tmp = fp + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, fp);

  if (isVercel) {
    queueMongoSync(collection, data, userId);
  }
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
  constructor(private name: string) { }

  /** Generate a new unique ID */
  static newId(): string {
    return randomUUID();
  }

  findMany(filter: Filter = {}, options: { sort?: Record<string, 1 | -1>; limit?: number } = {}): any[] {
    const userId = resolveUserId(this.name, filter);
    let docs = readCollection(this.name, userId).filter((d) => matchesFilter(d, filter));
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
    const userId = resolveUserId(this.name, filter);
    return readCollection(this.name, userId).find((d) => matchesFilter(d, filter)) ?? null;
  }

  insertOne(doc: any): { insertedId: string } {
    const userId = resolveUserId(this.name, null, doc);
    const data = readCollection(this.name, userId);
    const id = doc.id || Collection.newId();
    const newDoc = { ...doc, id };

    // Register Mapping
    if (this.name === "database_connections") {
      updateMapping("connections", id, userId);
    } else if (this.name === "query_jobs") {
      updateMapping("jobs", id, userId);
    } else if (this.name === "chat_sessions") {
      updateMapping("sessions", id, userId);
    }

    data.push(newDoc);
    writeCollection(this.name, data, userId);
    return { insertedId: id };
  }

  insertMany(docs: any[]): { insertedIds: string[] } {
    const insertedIds: string[] = [];
    if (docs.length === 0) return { insertedIds };

    const userId = resolveUserId(this.name, null, docs[0]);
    const data = readCollection(this.name, userId);

    for (const doc of docs) {
      const id = doc.id || Collection.newId();
      data.push({ ...doc, id });
      insertedIds.push(id);

      // Register Mapping
      if (this.name === "database_connections") {
        updateMapping("connections", id, userId);
      } else if (this.name === "query_jobs") {
        updateMapping("jobs", id, userId);
      } else if (this.name === "chat_sessions") {
        updateMapping("sessions", id, userId);
      }
    }
    writeCollection(this.name, data, userId);
    return { insertedIds };
  }

  updateOne(filter: Filter, update: { $set?: Record<string, any>; $unset?: Record<string, any> }): { matchedCount: number; modifiedCount: number } {
    const userId = resolveUserId(this.name, filter, update);
    const data = readCollection(this.name, userId);
    const idx = data.findIndex((d) => matchesFilter(d, filter));
    if (idx === -1) return { matchedCount: 0, modifiedCount: 0 };
    if (update.$set) Object.assign(data[idx], update.$set);
    if (update.$unset) {
      for (const key of Object.keys(update.$unset)) {
        delete data[idx][key];
      }
    }
    writeCollection(this.name, data, userId);
    return { matchedCount: 1, modifiedCount: 1 };
  }

  updateMany(filter: Filter, update: { $set?: Record<string, any>; $unset?: Record<string, any> }): { matchedCount: number; modifiedCount: number } {
    const userId = resolveUserId(this.name, filter, update);
    const data = readCollection(this.name, userId);
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
    if (count > 0) writeCollection(this.name, data, userId);
    return { matchedCount: count, modifiedCount: count };
  }

  deleteOne(filter: Filter): { deletedCount: number } {
    const userId = resolveUserId(this.name, filter);
    const data = readCollection(this.name, userId);
    const idx = data.findIndex((d) => matchesFilter(d, filter));
    if (idx === -1) return { deletedCount: 0 };
    data.splice(idx, 1);
    writeCollection(this.name, data, userId);
    return { deletedCount: 1 };
  }

  deleteMany(filter: Filter): { deletedCount: number } {
    const userId = resolveUserId(this.name, filter);
    const data = readCollection(this.name, userId);
    const before = data.length;
    const filtered = data.filter((d) => !matchesFilter(d, filter));
    writeCollection(this.name, filtered, userId);
    return { deletedCount: before - filtered.length };
  }

  /** Count documents matching a filter */
  countDocuments(filter: Filter = {}): number {
    const userId = resolveUserId(this.name, filter);
    return readCollection(this.name, userId).filter((d) => matchesFilter(d, filter)).length;
  }

  /** Replace entire document */
  replaceOne(filter: Filter, replacement: any): { matchedCount: number; modifiedCount: number } {
    const userId = resolveUserId(this.name, filter, replacement);
    const data = readCollection(this.name, userId);
    const idx = data.findIndex((d) => matchesFilter(d, filter));
    if (idx === -1) return { matchedCount: 0, modifiedCount: 0 };
    const id = data[idx].id;
    data[idx] = { ...replacement, id };
    writeCollection(this.name, data, userId);
    return { matchedCount: 1, modifiedCount: 1 };
  }

  /** Get all data (for debugging / export) */
  all(): any[] {
    const userId = resolveUserId(this.name);
    return readCollection(this.name, userId);
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
let isSyncedFromMongo = false;

export async function getControlDb(): Promise<JsonDb> {
  debugger
  if (isVercel && !isSyncedFromMongo) {
    isSyncedFromMongo = true;
    await syncFromMongoOnStartup();
    migrateDefaultUserData();
  }
  if (_db) return _db;
  _db = {
    collection: (name: string) => getCollection(name),
  };
  return _db;
}

// ---------------------------------------------------------------------------
// Helper: new unique ID
// ---------------------------------------------------------------------------

export function newId(): string {
  return randomUUID();
}

export { DATA_DIR };
