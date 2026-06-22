import { getPgPool, getMongoClient as getTargetMongoClient } from "./pool-manager";
import { decryptPassword } from "./crypto-helper";
import { getControlDb } from "./json-db";

export interface ColumnMetadata {
  tableSchema: string;
  tableName: string;
  columnName: string;
  dataType: string;
  isNullable: boolean;
  isPrimaryKey: boolean;
  columnDefault: string | null;
  ordinalPosition: number;
  sampleValues?: string[] | null;
}

/**
 * Runs incremental database schema introspection and writes results straight to the control-plane MongoDB.
 */
export async function runIntrospection(
  connectionId: string,
  organizationId: string
): Promise<{ success: boolean; error?: string; tablesCount?: number }> {
  const controlDb = await getControlDb();
  const connColl = controlDb.collection("database_connections");
  const metaColl = controlDb.collection("schema_metadata");

  const connection = connColl.findOne({
    id: connectionId,
    organization_id: organizationId,
  });

  if (!connection) {
    return { success: false, error: "Connection not found or unauthorized." };
  }

  try {
    // Clear existing metadata for this connection
    metaColl.deleteMany({ connection_id: connectionId });

    let tablesCount = 0;

    if (connection.engine === "POSTGRESQL") {
      const decryptedPassword = decryptPassword(connection.encrypted_password);
      const pool = await getPgPool({
        id: connectionId,
        engine: "POSTGRESQL",
        host: connection.host,
        port: connection.port,
        dbName: connection.db_name,
        dbUser: connection.db_user,
        decryptedPassword,
        sslEnabled: connection.ssl_enabled ?? false,
      });

      const client = await pool.connect();
      try {
        // 1. Get all BASE tables
        const tablesResult = await client.query<{ table_schema: string; table_name: string }>(`
          SELECT table_schema, table_name
          FROM information_schema.tables
          WHERE table_schema NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
            AND table_type = 'BASE TABLE'
        `);

        tablesCount = tablesResult.rows.length;

        // 2. Fetch primary key references
        const pkResult = await client.query<{
          table_schema: string;
          table_name: string;
          column_name: string;
        }>(`
          SELECT kcu.table_schema, kcu.table_name, kcu.column_name
          FROM information_schema.key_column_usage kcu
          JOIN information_schema.table_constraints tc
            ON kcu.constraint_name = tc.constraint_name
           AND kcu.table_schema    = tc.table_schema
          WHERE tc.constraint_type = 'PRIMARY KEY'
        `);

        const pkSet = new Set(
          pkResult.rows.map((r) => `${r.table_schema}.${r.table_name}.${r.column_name}`)
        );

        // 3. Read table columns incrementally to avoid big in-memory payloads
        for (const tbl of tablesResult.rows) {
          const colsResult = await client.query<{
            column_name: string;
            data_type: string;
            is_nullable: string;
            column_default: string | null;
            ordinal_position: number;
          }>(`
            SELECT column_name, data_type, is_nullable, column_default, ordinal_position
            FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = $2
            ORDER BY ordinal_position
          `, [tbl.table_schema, tbl.table_name]);

          const docs = colsResult.rows.map((row) => ({
            connection_id: connectionId,
            table_schema: tbl.table_schema,
            table_name: tbl.table_name,
            column_name: row.column_name,
            data_type: row.data_type,
            is_nullable: row.is_nullable === "YES",
            is_primary_key: pkSet.has(`${tbl.table_schema}.${tbl.table_name}.${row.column_name}`),
            column_default: row.column_default,
            ordinal_position: row.ordinal_position,
            introspected_at: new Date().toISOString(),
          }));

          if (docs.length > 0) {
            metaColl.insertMany(docs);
          }
        }
      } finally {
        client.release();
      }
    } else if (connection.engine === "MONGODB") {
      const decryptedUri = decryptPassword(connection.encrypted_uri);
      const client = await getTargetMongoClient({
        id: connectionId,
        engine: "MONGODB" as const,
        decryptedUri,
        sslEnabled: connection.ssl_enabled ?? false,
      });

      const mdb = client.db(connection.db_name || undefined);
      const collectionInfos = await mdb.listCollections().toArray();

      const INTERNAL_COLLECTIONS = new Set([
        "organizations",
        "users",
        "database_connections",
        "schema_metadata",
        "report_templates",
        "system.views",
        "system.indexes",
      ]);

      const collectionNames = collectionInfos
        .map((c) => c.name)
        .filter((name) => !INTERNAL_COLLECTIONS.has(name));

      tablesCount = collectionNames.length;

      // Scan collections one by one
      for (const collName of collectionNames) {
        const coll = mdb.collection(collName);
        const samples = await coll.find({}).limit(100).toArray();

        const fieldMap = new Map<string, string>();
        const distinctValues = new Map<string, Set<any>>();

        for (const doc of samples) {
          const fields = collectFields(doc as Record<string, any>);
          for (const f of fields) {
            if (!fieldMap.has(f.path) || fieldMap.get(f.path) === "null") {
              fieldMap.set(f.path, f.bsonType);
            }
            if (f.bsonType === "string" && f.value !== undefined && f.value !== null) {
              let valSet = distinctValues.get(f.path);
              if (!valSet) {
                valSet = new Set();
                distinctValues.set(f.path, valSet);
              }
              if (valSet.size < 10) valSet.add(f.value);
            }
          }
        }

        let ordinal = 1;
        const docs = [];
        for (const [path, bsonType] of fieldMap) {
          docs.push({
            connection_id: connectionId,
            table_schema: connection.db_name || "default",
            table_name: collName,
            column_name: path,
            data_type: bsonType,
            is_nullable: true,
            is_primary_key: path === "_id",
            column_default: null,
            ordinal_position: ordinal++,
            introspected_at: new Date().toISOString(),
          });
        }

        if (docs.length > 0) {
          metaColl.insertMany(docs);
        }
      }
    } else {
      return { success: false, error: `Engine ${connection.engine} not supported.` };
    }

    // Success: mark connection state as CONNECTED
    connColl.updateOne(
      { id: connectionId },
      { $set: { status: "CONNECTED", lastTestedAt: new Date().toISOString() } }
    );

    return { success: true, tablesCount };
  } catch (err: any) {
    console.error("Introspection failed:", err);
    connColl.updateOne(
      { id: connectionId },
      { $set: { status: "FAILED", lastTestedAt: new Date().toISOString() } }
    );
    return { success: false, error: err.message || String(err) };
  }
}

/**
 * Runs introspection on dynamic, unsaved credentials during setup wizard.
 */
export async function introspectTransientSchema(
  creds: any
): Promise<{ success: boolean; tables: string[]; columns: any[]; error?: string }> {
  try {
    if (creds.engine === "POSTGRESQL") {
      const pool = await getPgPool({
        id: "temp-transient",
        engine: "POSTGRESQL",
        host: creds.host,
        port: creds.port,
        dbName: creds.dbName,
        dbUser: creds.dbUser,
        decryptedPassword: creds.password,
        sslEnabled: creds.sslEnabled ?? false,
      });

      const client = await pool.connect();
      try {
        await client.query("BEGIN READ ONLY");

        const result = await client.query<{
          table_schema: string;
          table_name: string;
          column_name: string;
          data_type: string;
          is_nullable: string;
          column_default: string | null;
          ordinal_position: number;
        }>(`
          SELECT
            c.table_schema,
            c.table_name,
            c.column_name,
            c.data_type,
            c.is_nullable,
            c.column_default,
            c.ordinal_position
          FROM information_schema.columns c
          JOIN information_schema.tables t
            ON c.table_schema = t.table_schema
           AND c.table_name   = t.table_name
          WHERE c.table_schema NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
            AND t.table_type = 'BASE TABLE'
          ORDER BY c.table_schema, c.table_name, c.ordinal_position
        `);

        const pkResult = await client.query<{
          table_schema: string;
          table_name: string;
          column_name: string;
        }>(`
          SELECT
            kcu.table_schema,
            kcu.table_name,
            kcu.column_name
          FROM information_schema.key_column_usage kcu
          JOIN information_schema.table_constraints tc
            ON kcu.constraint_name = tc.constraint_name
           AND kcu.table_schema    = tc.table_schema
          WHERE tc.constraint_type = 'PRIMARY KEY'
            AND kcu.table_schema NOT IN ('information_schema', 'pg_catalog')
        `);

        await client.query("COMMIT");

        const pkSet = new Set(
          pkResult.rows.map((r) => `${r.table_schema}.${r.table_name}.${r.column_name}`)
        );

        const columns = result.rows.map((row) => ({
          tableSchema: row.table_schema,
          tableName: row.table_name,
          columnName: row.column_name,
          dataType: row.data_type,
          isNullable: row.is_nullable === "YES",
          isPrimaryKey: pkSet.has(`${row.table_schema}.${row.table_name}.${row.column_name}`),
          columnDefault: row.column_default,
          ordinalPosition: row.ordinal_position,
        }));

        const tables = [...new Set(columns.map((c) => `${c.tableSchema}.${c.tableName}`))];

        return { success: true, tables, columns };
      } finally {
        client.release();
      }
    } else if (creds.engine === "MONGODB") {
      const client = await getTargetMongoClient({
        id: "temp-transient",
        engine: "MONGODB",
        decryptedUri: creds.connectionUri,
        sslEnabled: creds.sslEnabled ?? false,
      });

      let dbName = creds.dbName;
      if (!dbName) {
        const url = new URL(
          creds.connectionUri.replace("mongodb+srv://", "https://").replace("mongodb://", "http://")
        );
        dbName = url.pathname.replace(/^\//, "").split("?")[0] || "default";
      }

      const mdb = client.db(dbName);
      const collectionInfos = await mdb.listCollections().toArray();

      const INTERNAL_COLLECTIONS = new Set([
        "organizations",
        "users",
        "database_connections",
        "schema_metadata",
        "report_templates",
        "system.views",
        "system.indexes",
      ]);

      const collectionNames = collectionInfos
        .map((c) => c.name)
        .filter((name) => !INTERNAL_COLLECTIONS.has(name));

      const columns: any[] = [];
      const tables: string[] = [];

      for (const collName of collectionNames) {
        tables.push(`${dbName}.${collName}`);
        const coll = mdb.collection(collName);
        const samples = await coll.find({}).limit(100).toArray();

        const fieldMap = new Map<string, string>();
        const distinctValues = new Map<string, Set<any>>();
        for (const doc of samples) {
          const fields = collectFields(doc as Record<string, any>);
          for (const f of fields) {
            if (!fieldMap.has(f.path) || fieldMap.get(f.path) === "null") {
              fieldMap.set(f.path, f.bsonType);
            }
            if (f.bsonType === "string" && f.value !== undefined && f.value !== null) {
              let valSet = distinctValues.get(f.path);
              if (!valSet) {
                valSet = new Set();
                distinctValues.set(f.path, valSet);
              }
              if (valSet.size < 10) valSet.add(f.value);
            }
          }
        }

        let ordinal = 1;
        for (const [path, bsonType] of fieldMap) {
          columns.push({
            tableSchema: dbName,
            tableName: collName,
            columnName: path,
            dataType: bsonType,
            isNullable: true,
            isPrimaryKey: path === "_id",
            columnDefault: null,
            ordinalPosition: ordinal++,
            sampleValues: distinctValues.has(path) ? Array.from(distinctValues.get(path)!) : null,
          });
        }
      }

      return { success: true, tables, columns };
    } else {
      return { success: false, error: "Unsupported engine.", tables: [], columns: [] };
    }
  } catch (err: any) {
    return { success: false, error: err.message || String(err), tables: [], columns: [] };
  }
}

/**
 * Traverses a document and maps all nested paths.
 */
function collectFields(
  obj: Record<string, any>,
  prefix = ""
): Array<{ path: string; bsonType: string; value?: any }> {
  const fields: Array<{ path: string; bsonType: string; value?: any }> = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !(value instanceof Date) &&
      !(value instanceof Buffer) &&
      !("toHexString" in (value as object))
    ) {
      if (prefix.split(".").length < 2) {
        fields.push(...collectFields(value as Record<string, any>, fullPath));
      } else {
        fields.push({ path: fullPath, bsonType: "object" });
      }
    } else {
      const bsonType = Array.isArray(value)
        ? "array"
        : value === null
        ? "null"
        : value instanceof Date
        ? "date"
        : typeof value === "object" && value !== null && "toHexString" in (value as object)
        ? "objectId"
        : typeof value === "number"
        ? Number.isInteger(value)
          ? "int"
          : "double"
        : typeof value === "boolean"
          ? "bool"
          : "string";
      fields.push({ path: fullPath, bsonType, value });
    }
  }
  return fields;
}
