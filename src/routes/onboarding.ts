import { Router } from "express";
import { getControlDb, newId } from "../json-db";
import { LINK_EXPIRY } from "../constants";
import { getFrontendUrl } from "../utils";

const router = Router();

export enum EngineType {
  MONGODB = "MONGODB",
  POSTGRESQL = "POSTGRESQL",
  MYSQL = "MYSQL"
}

export enum EngineEnum {
  MONGO = 0,
  POSTGRE = 1,
  MYSQL = 2
}

export function normalizeEngine(engineInput: any): EngineType | null {
  if (engineInput === undefined || engineInput === null) return null;

  // Handle numeric codes (either as number or string representation)
  const val = Number(engineInput);
  if (!isNaN(val) && engineInput !== "" && engineInput !== null && typeof engineInput !== "boolean") {
    if (val === EngineEnum.MONGO) return EngineType.MONGODB;
    if (val === EngineEnum.POSTGRE) return EngineType.POSTGRESQL;
    if (val === EngineEnum.MYSQL) return EngineType.MYSQL;
  }

  // Fallback to string names
  if (typeof engineInput === "string") {
    const lower = engineInput.toLowerCase().trim();
    if (lower === "mongo" || lower === "mongodb") {
      return EngineType.MONGODB;
    }
    if (lower === "postgre" || lower === "postgresql") {
      return EngineType.POSTGRESQL;
    }
    if (lower === "mysql") {
      return EngineType.MYSQL;
    }
  }

  return null;
}

export function normalizeDatabaseConnection(db: any) {
  const engine = normalizeEngine(db.engine);
  if (!engine) {
    throw new Error(`Unsupported database engine: ${db.engine || "undefined"}. Must be one of 0 (mongo), 1 (postgre), 2 (mysql).`);
  }

  const alias = db.name || db.alias;
  if (!alias) {
    throw new Error("Database connection name/alias (name) is required.");
  }

  const connectionUri = db.connectionString || db.connectionUri || db.connection_string || null;
  const host = db.host || db.hostname || db.hostName || null;
  const port = db.port ? Number(db.port) : null;
  const dbName = db.dbName || db.db_name || db.database || null;
  const dbUser = db.dbUser || db.db_user || db.username || db.user || null;
  const password = db.password || null;
  const sslEnabled = db.sslEnabled === true || db.ssl === true || db.ssl_enabled === true;
  const tables = Array.isArray(db.tables) ? db.tables : [];

  if (engine === EngineType.MONGODB) {
    if (!connectionUri) {
      throw new Error(`Connection string/URI (connectionString) is required for database "${alias}" when using MONGODB engine.`);
    }
  } else {
    const missing = [];
    if (!host) missing.push("hostname (host)");
    if (!dbUser) missing.push("username (dbUser)");
    if (!password) missing.push("password");
    if (!dbName) missing.push("database name (dbName)");

    if (missing.length > 0) {
      throw new Error(`Missing required fields [${missing.join(", ")}] for database "${alias}" when using ${engine} engine.`);
    }
  }

  return {
    alias,
    engine,
    connectionUri,
    host,
    port,
    dbName,
    dbUser,
    password,
    sslEnabled,
    tables,
  };
}

/**
 * POST /api/onboard
 * Public API for external systems to onboard users.
 * Body: { name: string, email: string }
 * Response:
 *   - New user:      { redirectionUrl: "<FRONTEND_URL>/set-password/<guid>" }
 *   - Existing user: { redirectionUrl: "<FRONTEND_URL>/signin?email=<encoded>" }
 */
router.post("/", async (req, res) => {
  try {
    const { name, email, database } = req.body;

    if (!name || !email) {
      return res.status(400).json({ error: "name and email are required." });
    }

    const normalizedEmail = email.toLowerCase().trim();

    let normalizedDatabases: any[] = [];
    if (database !== undefined && database !== null) {
      if (!Array.isArray(database)) {
        return res.status(400).json({ error: "database field must be an array." });
      }
      if (database.length > 0) {
        try {
          normalizedDatabases = database.map(normalizeDatabaseConnection);
        } catch (err: any) {
          return res.status(400).json({ error: err.message });
        }
      }
    }

    const db = await getControlDb();
    const usersColl = db.collection("users");

    // Check if user already exists
    const existingUser = usersColl.findOne({ email: normalizedEmail });
    if (existingUser) {
      const loginUrl = `${getFrontendUrl(req)}/signin?email=${encodeURIComponent(normalizedEmail)}`;
      return res.json({
        existingUser: true,
        redirectionUrl: loginUrl,
        message: "User already exists. Use the login URL to authenticate.",
      });
    }

    // Check if there's already a pending prospect for this email
    const prospectsColl = db.collection("prospect_users");
    const existingProspect = prospectsColl.findOne({ email: normalizedEmail });

    let prospectId: string;
    if (existingProspect) {
      prospectId = existingProspect.id;
      // Update the name in case it changed
      prospectsColl.updateOne({ id: prospectId }, { $set: { name, database: normalizedDatabases } });
    } else {
      prospectId = newId();
      prospectsColl.insertOne({
        id: prospectId,
        name,
        email: normalizedEmail,
        database: normalizedDatabases,
        created_at: new Date().toISOString(),
      });
    }

    const setPasswordUrl = `${getFrontendUrl(req)}/set-password/${prospectId}`;
    return res.json({
      existingUser: false,
      redirectionUrl: setPasswordUrl,
      message: "Prospect user created. Use the set-password URL to complete registration.",
    });
  } catch (err: any) {
    console.error("Onboard Error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * GET /api/onboard/prospect/:id
 * Returns prospect user info (name + email) for the set-password page.
 * Public — no sensitive data exposed.
 */
router.get("/prospect/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const db = await getControlDb();
    const prospect = db.collection("prospect_users").findOne({ id });

    if (!prospect) {
      return res.status(404).json({ error: "Prospect user not found or link has expired." });
    }

    // Check expiration (LINK_EXPIRY)
    if (prospect.created_at) {
      const createdTime = new Date(prospect.created_at).getTime();
      const diffMs = Date.now() - createdTime;
      if (diffMs > LINK_EXPIRY) {
        await deleteProspectUser(id);
        return res.status(404).json({ error: "Prospect user not found or link has expired." });
      }
    }

    // Expose createdAt for front-end verification
    return res.json({ name: prospect.name, email: prospect.email, createdAt: prospect.created_at });
  } catch (err: any) {
    console.error("Prospect lookup error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * Deletes a prospect user / onboarding link by ID.
 */
export async function deleteProspectUser(id: string) {
  const db = await getControlDb();
  db.collection("prospect_users").deleteOne({ id });
}

/**
 * DELETE /api/onboard/prospect/:id
 * Public API to delete prospect user data / onboarding link.
 */
router.delete("/prospect/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await deleteProspectUser(id);
    return res.json({ success: true, message: "Prospect user / onboarding link deleted successfully." });
  } catch (err: any) {
    console.error("Prospect deletion error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

export default router;
