"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const path_1 = __importDefault(require("path"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
// Load environment variables (look in server root first, then fall back to parent monorepo folder)
dotenv_1.default.config({ path: path_1.default.join(__dirname, "../.env") });
dotenv_1.default.config({ path: path_1.default.join(__dirname, "../../.env") });
const json_db_1 = require("./json-db");
const introspection_1 = require("./introspection");
const pool_manager_1 = require("./pool-manager");
const swagger_spec_1 = require("./swagger-spec");
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const auth_1 = __importDefault(require("./routes/auth"));
const chat_1 = __importDefault(require("./routes/chat"));
const connections_1 = __importDefault(require("./routes/connections"));
const onboarding_1 = __importDefault(require("./routes/onboarding"));
const templates_1 = __importDefault(require("./routes/templates"));
const upload_1 = __importDefault(require("./routes/upload"));
const app = (0, express_1.default)();
const PORT = process.env.BACKEND_PORT || 3002;
const BACKEND_SECRET = process.env.BACKEND_SECRET || "bi-lite-backend-secret-key-super-secure-87654321";
app.use((0, cors_1.default)({ origin: process.env.FRONTEND_URL || "http://localhost:3000", credentials: true }));
app.use(express_1.default.json({ limit: "50mb" }));
app.use((0, cookie_parser_1.default)());
// Serve Swagger UI API documentation
app.get("/api-docs/json", (req, res) => {
    res.json(swagger_spec_1.swaggerDocument);
});
app.get("/api-docs", (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>API Documentation</title>
  <link rel="stylesheet" type="text/css" href="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/4.18.3/swagger-ui.css" >
  <link rel="icon" type="image/png" href="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/4.18.3/favicon-32x32.png" sizes="32x32" />
  <style>
    html { box-sizing: border-box; overflow: -moz-scrollbars-vertical; overflow-y: scroll; }
    *, *:before, *:after { box-sizing: inherit; }
    body { margin: 0; background: #fafafa; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/4.18.3/swagger-ui-bundle.js"> </script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/4.18.3/swagger-ui-standalone-preset.js"> </script>
  <script>
    window.onload = function() {
      const ui = SwaggerUIBundle({
        url: "/api-docs/json",
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
        plugins: [SwaggerUIBundle.plugins.DownloadUrl],
        layout: "StandaloneLayout"
      });
      window.ui = ui;
    };
  </script>
</body>
</html>`);
});
// ---------------------------------------------------------------------------
// Authentication Middleware
// ---------------------------------------------------------------------------
const authMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(" ")[1];
    if (!token) {
        return res.status(401).json({ error: "Missing authorization token." });
    }
    try {
        const decoded = jsonwebtoken_1.default.verify(token, BACKEND_SECRET);
        req.user = decoded;
        next();
    }
    catch (err) {
        return res.status(403).json({ error: "Invalid or expired authorization token." });
    }
};
// Mount routes
app.use("/api/auth", auth_1.default);
app.use("/api/chat", authMiddleware, chat_1.default);
app.use("/api/connections", authMiddleware, connections_1.default);
app.use("/api/onboard", onboarding_1.default); // Public — no auth middleware
app.use("/api/templates", authMiddleware, templates_1.default);
app.use("/api/upload", authMiddleware, upload_1.default);
// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get("/health", (req, res) => {
    res.json({ status: "healthy", timestamp: new Date() });
});
/**
 * Test a database connection before saving it
 */
app.post("/api/connection/test", authMiddleware, async (req, res) => {
    const creds = req.body;
    const start = Date.now();
    try {
        if (creds.engine === "MONGODB") {
            let testUri = creds.connectionUri;
            if (testUri === "mongodb+srv://********************************************************") {
                testUri = process.env.SAMPLE_DATASET_URI || "";
            }
            if (!testUri) {
                return res.status(400).json({ success: false, error: "Connection URI required." });
            }
            const client = await (0, pool_manager_1.getMongoClient)({
                id: "temp-test",
                engine: "MONGODB",
                decryptedUri: testUri,
                sslEnabled: creds.sslEnabled ?? false,
            });
            const info = await client.db().admin().serverInfo();
            return res.json({
                success: true,
                latencyMs: Date.now() - start,
                serverVersion: `MongoDB ${info.version}`,
            });
        }
        else if (creds.engine === "POSTGRESQL") {
            const sslParam = creds.sslEnabled ? "?sslmode=require" : "?sslmode=disable";
            const connectionString = `postgresql://${encodeURIComponent(creds.dbUser)}:${encodeURIComponent(creds.password)}` +
                `@${creds.host}:${creds.port}/${encodeURIComponent(creds.dbName)}${sslParam}`;
            const pool = await (0, pool_manager_1.getPgPool)({
                id: "temp-test",
                engine: "POSTGRESQL",
                host: creds.host,
                port: creds.port,
                dbName: creds.dbName,
                dbUser: creds.dbUser,
                decryptedPassword: creds.password,
                sslEnabled: creds.sslEnabled ?? false,
            });
            const pgClient = await pool.connect();
            try {
                const result = await pgClient.query("SELECT version() AS version");
                const shortVersion = (result.rows[0]?.version ?? "PostgreSQL").split(" ").slice(0, 2).join(" ");
                return res.json({
                    success: true,
                    latencyMs: Date.now() - start,
                    serverVersion: shortVersion,
                });
            }
            finally {
                pgClient.release();
            }
        }
        else {
            return res.status(400).json({ success: false, error: "Unsupported engine." });
        }
    }
    catch (err) {
        console.error("Test connection failed:", err);
        return res.json({ success: false, error: err.message || String(err) });
    }
});
/**
 * Run schema introspection on dynamic setup credentials (transient)
 */
app.post("/api/connection/introspect", authMiddleware, async (req, res) => {
    const creds = req.body;
    if (creds.connectionUri === "mongodb+srv://********************************************************") {
        creds.connectionUri = process.env.SAMPLE_DATASET_URI || "";
    }
    const result = await (0, introspection_1.introspectTransientSchema)(creds);
    return res.json(result);
});
/**
 * Trigger schema introspection for a saved connection
 */
app.post("/api/introspection/run", authMiddleware, async (req, res) => {
    const { connectionId } = req.body;
    const organizationId = req.user.organizationId;
    if (!connectionId) {
        return res.status(400).json({ success: false, error: "Connection ID is required." });
    }
    const result = await (0, introspection_1.runIntrospection)(connectionId, organizationId);
    return res.json(result);
});
/**
 * Trigger an asynchronous query execution job
 */
app.post("/api/query/execute", authMiddleware, async (req, res) => {
    const { connectionId, query } = req.body;
    const organizationId = req.user.organizationId;
    if (!connectionId || !query) {
        return res.status(400).json({ success: false, error: "Missing required parameters." });
    }
    try {
        const controlDb = await (0, json_db_1.getControlDb)();
        const connColl = controlDb.collection("database_connections");
        const conn = connColl.findOne({ id: connectionId, organization_id: organizationId });
        if (!conn) {
            return res.status(404).json({ success: false, error: "Database connection not found or unauthorized." });
        }
        const jobsColl = controlDb.collection("query_jobs");
        const jobId = (0, json_db_1.newId)();
        jobsColl.insertOne({
            id: jobId,
            organizationId,
            connectionId,
            query,
            status: "pending",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        });
        // Start background worker, do not await it
        const { startQueryJob } = require("./query-job");
        startQueryJob(jobId, {
            connectionId,
            engine: conn.engine,
            query,
            organizationId,
        }).catch((err) => {
            console.error(`Background worker failed for job ${jobId}:`, err);
        });
        return res.json({ success: true, jobId });
    }
    catch (err) {
        console.error("Failed to enqueue job:", err);
        return res.status(500).json({ success: false, error: err.message || String(err) });
    }
});
/**
 * Retrieve execution job status
 */
app.get("/api/query/status/:jobId", authMiddleware, async (req, res) => {
    const { jobId } = req.params;
    const organizationId = req.user.organizationId;
    try {
        const controlDb = await (0, json_db_1.getControlDb)();
        const job = controlDb.collection("query_jobs").findOne({ id: jobId, organizationId });
        if (!job) {
            return res.status(404).json({ success: false, error: "Query job not found." });
        }
        return res.json({
            success: true,
            status: job.status,
            rowCount: job.rowCount || 0,
            columns: job.columns || [],
            durationMs: job.durationMs || 0,
            error: job.error || null,
        });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message || String(err) });
    }
});
/**
 * Get a paginated chunk of query results
 */
app.get("/api/query/results/:jobId", authMiddleware, async (req, res) => {
    const { jobId } = req.params;
    const page = parseInt(req.query.page || "1", 10);
    const organizationId = req.user.organizationId;
    const pageSize = 500;
    try {
        const controlDb = await (0, json_db_1.getControlDb)();
        const job = controlDb.collection("query_jobs").findOne({ id: jobId, organizationId });
        if (!job) {
            return res.status(404).json({ success: false, error: "Query job not found." });
        }
        if (job.status !== "completed") {
            return res.status(400).json({
                success: false,
                error: `Results are not ready. Job status: ${job.status}`,
            });
        }
        const resultDoc = controlDb.collection("query_job_results").findOne({ jobId, pageNum: page });
        const totalPages = Math.ceil((job.rowCount || 0) / pageSize);
        return res.json({
            success: true,
            rows: resultDoc?.rows || [],
            pageNum: page,
            totalPages: totalPages === 0 ? 1 : totalPages,
            rowCount: job.rowCount || 0,
        });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message || String(err) });
    }
});
app.listen(PORT, () => {
    console.log(`Dedicated Node.js backend server listening on port ${PORT}`);
});
