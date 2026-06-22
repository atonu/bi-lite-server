import { getPgPool, getMongoClient as getTargetMongoClient } from "./pool-manager";
import { decryptPassword } from "./crypto-helper";
import { getControlDb, newId } from "./json-db";

// Define the maximum rows we store for a single query job to prevent infinite scans
const MAX_JOB_ROWS_LIMIT = 50_000;
const PAGE_SIZE = 500;

/**
 * Re-export getControlDb so other modules can import it from here (backward-compatible).
 */
export { getControlDb } from "./json-db";

/**
 * Decrypt helper since backend needs to decode credentials before connecting.
 */
function decrypt(cipherText: string): string {
  return decryptPassword(cipherText);
}

interface JobData {
  connectionId: string;
  engine: "POSTGRESQL" | "MYSQL" | "MONGODB";
  query: string;
  organizationId: string;
}

/**
 * Starts a query execution job in the background.
 */
export async function startQueryJob(jobId: string, data: JobData): Promise<void> {
  const controlDb = await getControlDb();
  const jobsColl = controlDb.collection("query_jobs");
  const resultsColl = controlDb.collection("query_job_results");

  // Update status to processing
  jobsColl.updateOne({ id: jobId }, { $set: { status: "processing", updatedAt: new Date().toISOString() } });

  try {
    // 1. Fetch connection credentials from control plane
    const connColl = controlDb.collection("database_connections");
    const connection = connColl.findOne({ id: data.connectionId, organization_id: data.organizationId });

    if (!connection) {
      throw new Error("Target database connection not found or unauthorized.");
    }

    const start = Date.now();
    let rowsCount = 0;
    let columns: string[] = [];
    let pageNum = 1;
    let pageRows: any[] = [];

    // 2. Route execution based on engine
    if (data.engine === "POSTGRESQL") {
      // Decrypt password
      const decryptedPassword = decrypt(connection.encrypted_password);
      const pool = await getPgPool({
        id: data.connectionId,
        engine: "POSTGRESQL",
        host: connection.host,
        port: connection.port,
        dbName: connection.db_name,
        dbUser: connection.db_user,
        decryptedPassword,
        sslEnabled: connection.ssl_enabled ?? false,
      });

      const pgClient = await pool.connect();
      try {
        // Enforce read-only transaction
        await pgClient.query("BEGIN READ ONLY");

        // Execute query
        const result = await pgClient.query(data.query);
        await pgClient.query("COMMIT");

        columns = result.fields.map((f) => f.name);

        for (const row of result.rows) {
          if (rowsCount >= MAX_JOB_ROWS_LIMIT) break;
          pageRows.push(row);
          rowsCount++;

          if (pageRows.length === PAGE_SIZE) {
            resultsColl.insertOne({
              jobId,
              pageNum,
              rows: pageRows,
              createdAt: new Date().toISOString(),
            });
            pageNum++;
            pageRows = [];
          }
        }
      } catch (err) {
        await pgClient.query("ROLLBACK").catch(() => { });
        throw err;
      } finally {
        pgClient.release();
      }
    } else if (data.engine === "MONGODB") {
      // MongoDB Aggregation pipeline
      const decryptedUri = decrypt(connection.encrypted_uri);
      const client = await getTargetMongoClient({
        id: data.connectionId,
        engine: "MONGODB",
        decryptedUri,
        sslEnabled: connection.ssl_enabled ?? false,
      });

      let payload: { collection: string; pipeline: any[] };
      try {
        payload = JSON.parse(data.query);
      } catch {
        throw new Error("Invalid MongoDB query payload JSON.");
      }

      const mdb = client.db(connection.db_name || undefined);
      const coll = mdb.collection(payload.collection);

      const cursor = coll.aggregate(payload.pipeline, { allowDiskUse: true });
      const docs = await cursor.toArray();

      if (docs.length > 0) {
        // Find columns
        const columnSet = new Set<string>();
        for (const doc of docs) {
          for (const key of Object.keys(doc)) {
            columnSet.add(key);
          }
        }
        columns = Array.from(columnSet);

        for (const doc of docs) {
          if (rowsCount >= MAX_JOB_ROWS_LIMIT) break;

          const row: any = {};
          for (const col of columns) {
            const val = doc[col];
            if (val === undefined || val === null) {
              row[col] = null;
            } else if (typeof val === "object" && "toHexString" in val) {
              row[col] = (val as { toHexString: () => string }).toHexString();
            } else if (val instanceof Date) {
              row[col] = val.toISOString();
            } else if (typeof val === "object") {
              row[col] = JSON.stringify(val);
            } else {
              row[col] = val;
            }
          }

          pageRows.push(row);
          rowsCount++;

          if (pageRows.length === PAGE_SIZE) {
            resultsColl.insertOne({
              jobId,
              pageNum,
              rows: pageRows,
              createdAt: new Date().toISOString(),
            });
            pageNum++;
            pageRows = [];
          }
        }
      }
    } else {
      throw new Error(`Engine ${data.engine} is not supported on backend.`);
    }

    // Insert any remaining items in the last page
    if (pageRows.length > 0) {
      resultsColl.insertOne({
        jobId,
        pageNum,
        rows: pageRows,
        createdAt: new Date().toISOString(),
      });
    }

    const durationMs = Date.now() - start;

    // Mark job as completed
    jobsColl.updateOne(
      { id: jobId },
      {
        $set: {
          status: "completed",
          rowCount: rowsCount,
          columns,
          durationMs,
          updatedAt: new Date().toISOString(),
        },
      }
    );
  } catch (err: any) {
    console.error(`Job ${jobId} failed:`, err);
    jobsColl.updateOne(
      { id: jobId },
      {
        $set: {
          status: "failed",
          error: err.message || String(err),
          updatedAt: new Date().toISOString(),
        },
      }
    );
  }
}
