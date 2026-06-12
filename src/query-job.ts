import { MongoClient, ObjectId } from "mongodb";
import { getPgPool, getMongoClient as getTargetMongoClient } from "./pool-manager";
import { decryptPassword } from "./crypto-helper";
import { Parser } from "node-sql-parser";
import { STATEMENT_TIMEOUT } from "./constants";

// Define the maximum rows we store for a single query job to prevent infinite scans
const MAX_JOB_ROWS_LIMIT = 50_000;
const PAGE_SIZE = 500;

let controlClient: MongoClient | null = null;

/**
 * Retrieve control plane database connection.
 */
export async function getControlDb() {
  if (controlClient) return controlClient.db();
  const uri = process.env.MONGODB_URI || process.env.DATABASE_URL || "mongodb://localhost:27017/bi_lite";
  controlClient = new MongoClient(uri);
  await controlClient.connect();
  return controlClient.db();
}

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
  await jobsColl.updateOne({ _id: new ObjectId(jobId) }, { $set: { status: "processing", updatedAt: new Date() } });

  try {
    // 1. Fetch connection credentials from control plane
    const connColl = controlDb.collection("database_connections");
    const connection = await connColl.findOne({ _id: new ObjectId(data.connectionId), organization_id: new ObjectId(data.organizationId) });

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
        // --- 4. AST Parsing Middleware ---
        try {
          const parser = new Parser();
          const ast = parser.astify(data.query, { database: "PostgresQL" });
          const statements = Array.isArray(ast) ? ast : [ast];

          for (const stmt of statements) {
            if (!stmt) continue;
            const type = (stmt.type || "").toLowerCase();
            if (["insert", "update", "delete", "drop", "alter", "truncate", "create", "grant", "revoke"].includes(type)) {
              throw new Error(`Execution blocked: Query contains destructive operation (${type.toUpperCase()}). Only SELECT queries are permitted.`);
            }
          }
        } catch (astErr: any) {
          // If our AST parser explicitly blocked it, rethrow
          if (astErr.message && astErr.message.includes("Execution blocked:")) {
            throw astErr;
          }
          // Otherwise, it might be a complex valid SELECT syntax node-sql-parser doesn't understand,
          // so we fallback to read-only transaction protection.
        }

        // --- 5. Hard statement_timeout ---
        await pgClient.query(`SET statement_timeout = '${STATEMENT_TIMEOUT}'`);

        // Enforce read-only transaction
        await pgClient.query("BEGIN READ ONLY");

        // --- 6. Pre-flight EXPLAIN checks ---
        const explainResult = await pgClient.query(`EXPLAIN (FORMAT JSON) ${data.query}`);
        const planObj = explainResult.rows[0] && (explainResult.rows[0]["QUERY PLAN"] || explainResult.rows[0]["query plan"]);
        const rootPlan = planObj && planObj[0] && planObj[0].Plan;

        function hasMassiveSeqScan(node: any): boolean {
          if (!node) return false;
          if (node["Node Type"] === "Seq Scan" && node["Plan Rows"] > 100000) {
            return true;
          }
          if (node.Plans && Array.isArray(node.Plans)) {
            for (const child of node.Plans) {
              if (hasMassiveSeqScan(child)) return true;
            }
          }
          return false;
        }

        if (hasMassiveSeqScan(rootPlan)) {
          throw new Error("Execution blocked: Pre-flight check detected a full table scan on a massive dataset. Please refine your question to be more specific.");
        }

        // Execute query
        const result = await pgClient.query(data.query);
        await pgClient.query("COMMIT");

        columns = result.fields.map((f) => f.name);

        for (const row of result.rows) {
          if (rowsCount >= MAX_JOB_ROWS_LIMIT) break;
          pageRows.push(row);
          rowsCount++;

          if (pageRows.length === PAGE_SIZE) {
            // Write page to results collection
            await resultsColl.insertOne({
              jobId: new ObjectId(jobId),
              pageNum,
              rows: pageRows,
              createdAt: new Date(),
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
      // MongoDBAggregation pipeline
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

        // Convert ObjectId/Date fields to strings to avoid serialization issues
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
            await resultsColl.insertOne({
              jobId: new ObjectId(jobId),
              pageNum,
              rows: pageRows,
              createdAt: new Date(),
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
      await resultsColl.insertOne({
        jobId: new ObjectId(jobId),
        pageNum,
        rows: pageRows,
        createdAt: new Date(),
      });
    }

    const durationMs = Date.now() - start;

    // Mark job as completed
    await jobsColl.updateOne(
      { _id: new ObjectId(jobId) },
      {
        $set: {
          status: "completed",
          rowCount: rowsCount,
          columns,
          durationMs,
          updatedAt: new Date(),
        },
      }
    );
  } catch (err: any) {
    console.error(`Job ${jobId} failed:`, err);
    await jobsColl.updateOne(
      { _id: new ObjectId(jobId) },
      {
        $set: {
          status: "failed",
          error: err.message || String(err),
          updatedAt: new Date(),
        },
      }
    );
  }
}
