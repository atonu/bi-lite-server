"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getControlDb = void 0;
exports.startQueryJob = startQueryJob;
const pool_manager_1 = require("./pool-manager");
const crypto_helper_1 = require("./crypto-helper");
const json_db_1 = require("./json-db");
// Define the maximum rows we store for a single query job to prevent infinite scans
const MAX_JOB_ROWS_LIMIT = 50_000;
const PAGE_SIZE = 500;
/**
 * Re-export getControlDb so other modules can import it from here (backward-compatible).
 */
var json_db_2 = require("./json-db");
Object.defineProperty(exports, "getControlDb", { enumerable: true, get: function () { return json_db_2.getControlDb; } });
/**
 * Decrypt helper since backend needs to decode credentials before connecting.
 */
function decrypt(cipherText) {
    return (0, crypto_helper_1.decryptPassword)(cipherText);
}
/**
 * Starts a query execution job in the background.
 */
async function startQueryJob(jobId, data) {
    const controlDb = await (0, json_db_1.getControlDb)();
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
        let columns = [];
        let pageNum = 1;
        let pageRows = [];
        // 2. Route execution based on engine
        if (data.engine === "POSTGRESQL") {
            // Decrypt password
            const decryptedPassword = decrypt(connection.encrypted_password);
            const pool = await (0, pool_manager_1.getPgPool)({
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
                    const parser = new node_sql_parser_1.Parser();
                    const ast = parser.astify(data.query, { database: "PostgresQL" });
                    const statements = Array.isArray(ast) ? ast : [ast];
                    for (const stmt of statements) {
                        if (!stmt)
                            continue;
                        const type = (stmt.type || "").toLowerCase();
                        if (["insert", "update", "delete", "drop", "alter", "truncate", "create", "grant", "revoke"].includes(type)) {
                            throw new Error(`Execution blocked: Query contains destructive operation (${type.toUpperCase()}). Only SELECT queries are permitted.`);
                        }
                    }
                }
                catch (astErr) {
                    // If our AST parser explicitly blocked it, rethrow
                    if (astErr.message && astErr.message.includes("Execution blocked:")) {
                        throw astErr;
                    }
                    // Otherwise, it might be a complex valid SELECT syntax node-sql-parser doesn't understand,
                    // so we fallback to read-only transaction protection.
                }
                // --- 5. Hard statement_timeout ---
                await pgClient.query("SET statement_timeout = '10s'");
                // Enforce read-only transaction
                await pgClient.query("BEGIN READ ONLY");
                // --- 6. Pre-flight EXPLAIN checks ---
                const explainResult = await pgClient.query(`EXPLAIN (FORMAT JSON) ${data.query}`);
                const planObj = explainResult.rows[0] && (explainResult.rows[0]["QUERY PLAN"] || explainResult.rows[0]["query plan"]);
                const rootPlan = planObj && planObj[0] && planObj[0].Plan;
                function hasMassiveSeqScan(node) {
                    if (!node)
                        return false;
                    if (node["Node Type"] === "Seq Scan" && node["Plan Rows"] > 100000) {
                        return true;
                    }
                    if (node.Plans && Array.isArray(node.Plans)) {
                        for (const child of node.Plans) {
                            if (hasMassiveSeqScan(child))
                                return true;
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
                    if (rowsCount >= MAX_JOB_ROWS_LIMIT)
                        break;
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
            catch (err) {
                await pgClient.query("ROLLBACK").catch(() => { });
                throw err;
            }
            finally {
                pgClient.release();
            }
        }
        else if (data.engine === "MONGODB") {
            // MongoDB Aggregation pipeline
            const decryptedUri = decrypt(connection.encrypted_uri);
            const client = await (0, pool_manager_1.getMongoClient)({
                id: data.connectionId,
                engine: "MONGODB",
                decryptedUri,
                sslEnabled: connection.ssl_enabled ?? false,
            });
            let payload;
            try {
                payload = JSON.parse(data.query);
            }
            catch {
                throw new Error("Invalid MongoDB query payload JSON.");
            }
            const mdb = client.db(connection.db_name || undefined);
            const coll = mdb.collection(payload.collection);
            const cursor = coll.aggregate(payload.pipeline, { allowDiskUse: true });
            const docs = await cursor.toArray();
            if (docs.length > 0) {
                // Find columns
                const columnSet = new Set();
                for (const doc of docs) {
                    for (const key of Object.keys(doc)) {
                        columnSet.add(key);
                    }
                }
                columns = Array.from(columnSet);
                for (const doc of docs) {
                    if (rowsCount >= MAX_JOB_ROWS_LIMIT)
                        break;
                    const row = {};
                    for (const col of columns) {
                        const val = doc[col];
                        if (val === undefined || val === null) {
                            row[col] = null;
                        }
                        else if (typeof val === "object" && "toHexString" in val) {
                            row[col] = val.toHexString();
                        }
                        else if (val instanceof Date) {
                            row[col] = val.toISOString();
                        }
                        else if (typeof val === "object") {
                            row[col] = JSON.stringify(val);
                        }
                        else {
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
        }
        else {
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
        jobsColl.updateOne({ id: jobId }, {
            $set: {
                status: "completed",
                rowCount: rowsCount,
                columns,
                durationMs,
                updatedAt: new Date().toISOString(),
            },
        });
    }
    catch (err) {
        console.error(`Job ${jobId} failed:`, err);
        jobsColl.updateOne({ id: jobId }, {
            $set: {
                status: "failed",
                error: err.message || String(err),
                updatedAt: new Date().toISOString(),
            },
        });
    }
}
