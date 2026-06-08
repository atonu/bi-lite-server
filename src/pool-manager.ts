import { Pool } from "pg";
import { MongoClient } from "mongodb";

export interface ConnectionConfig {
  id: string;
  engine: "POSTGRESQL" | "MYSQL" | "MONGODB";
  host?: string | null;
  port?: number | null;
  dbName?: string | null;
  dbUser?: string | null;
  decryptedPassword?: string | null;
  decryptedUri?: string | null;
  sslEnabled: boolean;
}

// In-memory caches for database connection instances
const pgPools = new Map<string, Pool>();
const mongoClients = new Map<string, MongoClient>();

/**
 * Retrieve or create a persistent PostgreSQL connection pool for a specific connection ID.
 */
export async function getPgPool(config: ConnectionConfig): Promise<Pool> {
  const cached = pgPools.get(config.id);
  if (cached) {
    return cached;
  }

  const sslParam = config.sslEnabled ? "?sslmode=require" : "?sslmode=disable";
  const connectionString =
    `postgresql://${encodeURIComponent(config.dbUser!)}:${encodeURIComponent(config.decryptedPassword!)}` +
    `@${config.host}:${config.port}/${encodeURIComponent(config.dbName!)}${sslParam}`;

  const pool = new Pool({
    connectionString,
    max: 15, // Allow up to 15 concurrent connections per pool
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 60_000, // Reclaim connections after 60s of inactivity
    ssl: config.sslEnabled ? { rejectUnauthorized: false } : undefined,
  });

  pgPools.set(config.id, pool);
  return pool;
}

/**
 * Retrieve or create a persistent MongoDB Client connection for a specific connection ID.
 */
export async function getMongoClient(config: ConnectionConfig): Promise<MongoClient> {
  const cached = mongoClients.get(config.id);
  if (cached) {
    return cached;
  }

  if (!config.decryptedUri) {
    throw new Error("MongoDB connection URI is missing.");
  }

  const client = new MongoClient(config.decryptedUri, {
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 10_000,
    maxPoolSize: 15, // Allow up to 15 concurrent connections in pool
    minPoolSize: 2,
    ...(config.sslEnabled && { tls: true, tlsAllowInvalidCertificates: true }),
  });

  await client.connect();
  mongoClients.set(config.id, client);
  return client;
}

/**
 * Safely disconnect and remove a cached connection.
 */
export async function removeConnection(id: string): Promise<void> {
  const pgPool = pgPools.get(id);
  if (pgPool) {
    try {
      await pgPool.end();
    } catch (err) {
      console.error(`Error closing Postgres pool ${id}:`, err);
    }
    pgPools.delete(id);
  }

  const mongoClient = mongoClients.get(id);
  if (mongoClient) {
    try {
      await mongoClient.close();
    } catch (err) {
      console.error(`Error closing MongoDB client ${id}:`, err);
    }
    mongoClients.delete(id);
  }
}

/**
 * Clean up all cached connection pools.
 */
export async function clearAllPools(): Promise<void> {
  const pgKeys = Array.from(pgPools.keys());
  const mongoKeys = Array.from(mongoClients.keys());

  for (const id of pgKeys) {
    await removeConnection(id);
  }
  for (const id of mongoKeys) {
    await removeConnection(id);
  }
  console.log("All connection pools cleared successfully.");
}
