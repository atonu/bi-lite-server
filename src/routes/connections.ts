import { Router, Response } from "express";
import crypto from "crypto";
import { MongoClient, ObjectId } from "mongodb";
import { getControlDb } from "../query-job";
import { encryptPassword } from "../crypto-helper";

const router = Router();

interface ConnectionCredentials {
  alias: string;
  engine: "POSTGRESQL" | "MYSQL" | "MONGODB";
  host?: string;
  port?: number;
  dbName?: string;
  dbUser?: string;
  password?: string;
  sslEnabled?: boolean;
  connectionUri?: string;
}

interface ColumnMetadata {
  tableSchema: string;
  tableName: string;
  columnName: string;
  dataType: string;
  isNullable: boolean;
  isPrimaryKey: boolean;
  columnDefault: string | null;
  ordinalPosition: number;
}

function computeConnectionUniqueKey(creds: ConnectionCredentials): string {
  const raw =
    creds.engine === "MONGODB"
      ? `MONGODB::${creds.connectionUri ?? ""}`
      : `${creds.engine}::${creds.host ?? ""}::${creds.port ?? ""}::${creds.dbName ?? ""}::${creds.dbUser ?? ""}`;
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/**
 * GET /api/connections
 * List active database connections for the user's organization.
 */
router.get("/", async (req: any, res: Response) => {
  try {
    const organizationId = req.user.organizationId;
    if (!organizationId) {
      return res.status(400).json({ error: "Missing organization context." });
    }

    const controlDb = await getControlDb();
    const connColl = controlDb.collection("database_connections");

    const connections = await connColl
      .find({
        organization_id: new ObjectId(organizationId),
        status: "CONNECTED",
      })
      .sort({ created_at: -1 })
      .toArray();

    const formatted = connections.map((c) => ({
      id: c._id.toString(),
      alias: c.alias,
      engine: c.engine,
      host: c.host,
      dbName: c.db_name,
      status: c.status,
    }));

    return res.json(formatted);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || String(err) });
  }
});

/**
 * GET /api/connections/all
 * List all database connections (management) for the user's organization.
 */
router.get("/all", async (req: any, res: Response) => {
  try {
    const organizationId = req.user.organizationId;
    if (!organizationId) {
      return res.status(400).json({ error: "Missing organization context." });
    }

    const controlDb = await getControlDb();
    const connColl = controlDb.collection("database_connections");

    const connections = await connColl
      .find({
        organization_id: new ObjectId(organizationId),
      })
      .sort({ created_at: -1 })
      .toArray();

    const formatted = connections.map((c) => ({
      id: c._id.toString(),
      alias: c.alias,
      engine: c.engine,
      host: c.host,
      port: c.port,
      dbName: c.db_name,
      dbUser: c.db_user,
      sslEnabled: c.ssl_enabled,
      status: c.status,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      lastTestedAt: c.last_tested_at,
    }));

    return res.json(formatted);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || String(err) });
  }
});

/**
 * POST /api/connections
 * Save a new database connection and its introspected schema metadata.
 */
router.post("/", async (req: any, res: Response) => {
  try {
    const organizationId = req.user.organizationId;
    if (!organizationId) {
      return res.status(400).json({ error: "Missing organization context." });
    }

    const { creds, columns }: { creds: ConnectionCredentials; columns: ColumnMetadata[] } = req.body;

    if (!creds || !creds.alias || !creds.engine) {
      return res.status(400).json({ success: false, error: "Missing connection credentials." });
    }

    // Encrypt sensitive fields
    let encryptedPassword: string | null = null;
    let encryptedUri: string | null = null;

    if (creds.engine === "MONGODB") {
      if (!creds.connectionUri) {
        return res.status(400).json({ success: false, error: "MongoDB connection URI is required." });
      }
      encryptedUri = encryptPassword(creds.connectionUri);
    } else {
      if (!creds.password) {
        return res.status(400).json({ success: false, error: "Password is required." });
      }
      encryptedPassword = encryptPassword(creds.password);
    }

    const uniqueKey = computeConnectionUniqueKey(creds);

    const controlDb = await getControlDb();
    const connColl = controlDb.collection("database_connections");
    const schemaColl = controlDb.collection("schema_metadata");

    // Check unique key fingerprint
    const existing = await connColl.findOne({
      unique_key: uniqueKey,
      organization_id: new ObjectId(organizationId),
    });

    if (existing) {
      if (existing.status === "CONNECTED") {
        return res.status(400).json({
          success: false,
          error: `A connection to this database already exists: "${existing.alias}". Please edit the existing connection instead of creating a duplicate.`,
        });
      } else {
        // Delete the inactive/failed connection
        await connColl.deleteOne({ _id: existing._id });
        await schemaColl.deleteMany({ connection_id: existing._id });
      }
    }

    // Parse DB name for Mongo if needed
    let resolvedDbName = creds.dbName ?? null;
    if (creds.engine === "MONGODB" && !resolvedDbName && creds.connectionUri) {
      try {
        const url = new URL(
          creds.connectionUri
            .replace("mongodb+srv://", "https://")
            .replace("mongodb://", "http://")
        );
        const pathDb = url.pathname.replace(/^\//, "").split("?")[0];
        if (pathDb) resolvedDbName = pathDb;
      } catch {
        // ignore parse errors
      }
    }

    const connectionId = new ObjectId();

    // Insert new connection record
    await connColl.insertOne({
      _id: connectionId,
      alias: creds.alias,
      engine: creds.engine,
      host: creds.host ?? null,
      port: creds.port ?? null,
      db_name: resolvedDbName,
      db_user: creds.dbUser ?? null,
      encrypted_password: encryptedPassword,
      ssl_enabled: creds.sslEnabled ?? false,
      encrypted_uri: encryptedUri,
      unique_key: uniqueKey,
      status: "CONNECTED",
      last_tested_at: new Date(),
      organization_id: new ObjectId(organizationId),
      created_at: new Date(),
      updated_at: new Date(),
    });

    // Bulk-insert schema metadata
    if (columns && columns.length > 0) {
      await schemaColl.insertMany(
        columns.map((col) => ({
          table_schema: col.tableSchema,
          table_name: col.tableName,
          column_name: col.columnName,
          data_type: col.dataType,
          is_nullable: col.isNullable,
          is_primary_key: col.isPrimaryKey,
          column_default: col.columnDefault,
          ordinal_position: col.ordinalPosition,
          connection_id: connectionId,
          introspected_at: new Date(),
        }))
      );
    }

    return res.json({ success: true, connectionId: connectionId.toString() });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

/**
 * DELETE /api/connections/:id
 * Delete a database connection.
 */
router.delete("/:id", async (req: any, res: Response) => {
  try {
    const organizationId = req.user.organizationId;
    const { id: connectionId } = req.params;

    if (!organizationId || !connectionId) {
      return res.status(400).json({ success: false, error: "Missing required parameters." });
    }

    const controlDb = await getControlDb();
    const connColl = controlDb.collection("database_connections");
    const schemaColl = controlDb.collection("schema_metadata");
    const chatSessionsColl = controlDb.collection("chat_sessions");

    // Verify ownership
    const exists = await connColl.findOne({
      _id: new ObjectId(connectionId),
      organization_id: new ObjectId(organizationId),
    });

    if (!exists) {
      return res.status(404).json({ success: false, error: "Connection not found or unauthorized." });
    }

    // Cascade delete schema metadata
    await schemaColl.deleteMany({
      connection_id: new ObjectId(connectionId),
    });

    // Nullify references in chat sessions
    await chatSessionsColl.updateMany(
      { connection_id: new ObjectId(connectionId) },
      { $set: { connection_id: null } }
    );

    // Delete connection itself
    await connColl.deleteOne({
      _id: new ObjectId(connectionId),
    });

    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

/**
 * PATCH /api/connections/:id/alias
 * Update the connection alias.
 */
router.patch("/:id/alias", async (req: any, res: Response) => {
  try {
    const organizationId = req.user.organizationId;
    const { id: connectionId } = req.params;
    const { alias } = req.body;

    if (!organizationId || !connectionId || !alias) {
      return res.status(400).json({ success: false, error: "Missing required parameters." });
    }

    const controlDb = await getControlDb();
    const connColl = controlDb.collection("database_connections");

    // Verify ownership
    const exists = await connColl.findOne({
      _id: new ObjectId(connectionId),
      organization_id: new ObjectId(organizationId),
    });

    if (!exists) {
      return res.status(404).json({ success: false, error: "Connection not found or unauthorized." });
    }

    await connColl.updateOne(
      { _id: new ObjectId(connectionId) },
      { $set: { alias, updated_at: new Date() } }
    );

    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

/**
 * GET /api/connections/:id/schema
 * Retrieve cached schema metadata columns for a connection.
 */
router.get("/:id/schema", async (req: any, res: Response) => {
  try {
    const { id: connectionId } = req.params;
    const organizationId = req.user.organizationId;

    if (!connectionId || !organizationId) {
      return res.status(400).json({ error: "Missing required parameters." });
    }

    const controlDb = await getControlDb();
    const connColl = controlDb.collection("database_connections");
    const schemaColl = controlDb.collection("schema_metadata");

    // Verify ownership
    const conn = await connColl.findOne({
      _id: new ObjectId(connectionId),
      organization_id: new ObjectId(organizationId),
    });

    if (!conn) {
      return res.status(404).json({ error: "Connection not found or unauthorized." });
    }

    const schemaRows = await schemaColl
      .find({ connection_id: new ObjectId(connectionId) })
      .sort({ table_schema: 1, table_name: 1, ordinal_position: 1 })
      .toArray();

    const formatted = schemaRows.map((row) => ({
      tableSchema: row.table_schema,
      tableName: row.table_name,
      columnName: row.column_name,
      dataType: row.data_type,
      isNullable: row.is_nullable,
      isPrimaryKey: row.is_primary_key,
      columnDefault: row.column_default,
      ordinalPosition: row.ordinal_position,
    }));

    return res.json(formatted);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || String(err) });
  }
});

export default router;
