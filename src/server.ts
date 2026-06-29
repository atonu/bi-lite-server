import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import jwt from "jsonwebtoken";
import swaggerUi from "swagger-ui-express";

// Load environment variables (look in server root first, then fall back to parent monorepo folder)
dotenv.config({ path: path.join(__dirname, "../.env") });
dotenv.config({ path: path.join(__dirname, "../../.env") });

import { getControlDb, newId, userContextStorage, waitForPendingMongoSyncs } from "./json-db";
import { runIntrospection, introspectTransientSchema } from "./introspection";
import { getPgPool, getMongoClient } from "./pool-manager";
import { swaggerDocument } from "./swagger-spec";
import { ALLOWED_DOMAIN_SUFFIX } from "./constants";

import cookieParser from "cookie-parser";
import authRouter from "./routes/auth";
import chatRouter from "./routes/chat";
import connectionsRouter from "./routes/connections";
import onboardingRouter from "./routes/onboarding";
import templatesRouter from "./routes/templates";
import uploadRouter from "./routes/upload";

const app = express();
const PORT = process.env.BACKEND_PORT || 3002;
const BACKEND_SECRET = process.env.BACKEND_SECRET || "bi-lite-backend-secret-key-super-secure-87654321";

const allowedOrigins = (process.env.FRONTEND_URL || "")
  .split(",")
  .map((origin) => origin.trim().replace(/\/$/, ""))
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, or server-to-server)
      if (!origin) return callback(null, true);

      const isLocalhost = origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:");
      const isVercelSubdomain = origin.endsWith(ALLOWED_DOMAIN_SUFFIX);
      const isAllowedOrigin = allowedOrigins.some((allowed) => {
        if (allowed === origin) return true;
        try {
          const allowedHost = allowed.startsWith("http://") || allowed.startsWith("https://") ? new URL(allowed).host : allowed;
          return allowedHost.toLowerCase() === new URL(origin).host.toLowerCase();
        } catch {
          return false;
        }
      });

      if (isLocalhost || isVercelSubdomain || isAllowedOrigin) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  })
);
app.use(express.json({ limit: "50mb" }));
app.use(cookieParser());

// On Vercel, intercept response ending to block until all pending MongoDB background writes have been flushed
if (process.env.VERCEL === "1") {
  app.use((req, res, next) => {
    const originalEnd = res.end;
    let isEnding = false;

    res.end = function (...args: any[]) {
      if (isEnding) {
        return originalEnd.apply(res, args as any);
      }
      isEnding = true;

      waitForPendingMongoSyncs()
        .then(() => {
          originalEnd.apply(res, args as any);
        })
        .catch((err) => {
          console.error("[json-db] Error waiting for pending MongoDB syncs before ending response:", err);
          originalEnd.apply(res, args as any);
        });

      return res;
    } as any;

    next();
  });
}

// Serve Swagger UI API documentation
app.get("/api-docs/json", (req, res) => {
  res.json(swaggerDocument);
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

const authMiddleware = (req: any, res: any, next: any) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "Missing authorization token." });
  }

  try {
    const decoded = jwt.verify(token, BACKEND_SECRET) as any;
    req.user = decoded;

    // Normalize user ID to ensure id is always present
    if (req.user && !req.user.id && req.user.userId) {
      req.user.id = req.user.userId;
    }

    const userId = req.user.id;
    userContextStorage.run({ userId, organizationId: decoded.organizationId }, () => {
      next();
    });
  } catch (err) {
    return res.status(403).json({ error: "Invalid or expired authorization token." });
  }
};

// Mount routes
app.use("/api/auth", authRouter);
app.use("/api/chat", authMiddleware, chatRouter);
app.use("/api/connections", authMiddleware, connectionsRouter);
app.use("/api/onboard", onboardingRouter);           // Public — no auth middleware
app.use("/api/templates", authMiddleware, templatesRouter);
app.use("/api/upload", authMiddleware, uploadRouter);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/", (req, res) => {
  res.redirect("/api-docs");
});

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
        testUri = process.env.SAMPLE_DATASET_URI || "mongodb+srv://atonuzahin_db_user:2wsxXSW@dataview.fdlu509.mongodb.net/bilite-test";
      }
      if (!testUri) {
        return res.status(400).json({ success: false, error: "Connection URI required." });
      }
      const client = await getMongoClient({
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
    } else if (creds.engine === "POSTGRESQL") {
      const sslParam = creds.sslEnabled ? "?sslmode=require" : "?sslmode=disable";
      const connectionString =
        `postgresql://${encodeURIComponent(creds.dbUser!)}:${encodeURIComponent(creds.password!)}` +
        `@${creds.host}:${creds.port}/${encodeURIComponent(creds.dbName!)}${sslParam}`;

      const pool = await getPgPool({
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
      } finally {
        pgClient.release();
      }
    } else {
      return res.status(400).json({ success: false, error: "Unsupported engine." });
    }
  } catch (err: any) {
    console.error("Test connection failed:", err);
    return res.json({ success: false, error: err.message || String(err) });
  }
});

/**
 * Run schema introspection on dynamic setup credentials (transient)
 */
app.post("/api/connection/introspect", authMiddleware, async (req, res) => {
  try {
    const creds = req.body;
    if (creds.connectionUri === "mongodb+srv://********************************************************") {
      creds.connectionUri = process.env.SAMPLE_DATASET_URI || "mongodb+srv://atonuzahin_db_user:2wsxXSW@dataview.fdlu509.mongodb.net/bilite-test";
    }
    const result = await introspectTransientSchema(creds);
    return res.json(result);
  } catch (err: any) {
    console.error("[INTROSPECT] Error:", err.message || err);
    return res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

/**
 * Trigger schema introspection for a saved connection
 */
app.post("/api/introspection/run", authMiddleware, async (req, res) => {
  const { connectionId } = req.body;
  const organizationId = (req as any).user.organizationId;

  if (!connectionId) {
    return res.status(400).json({ success: false, error: "Connection ID is required." });
  }

  const result = await runIntrospection(connectionId, organizationId);
  return res.json(result);
});

/**
 * Trigger an asynchronous query execution job
 */
app.post("/api/query/execute", authMiddleware, async (req, res) => {
  const { connectionId, query } = req.body;
  const organizationId = (req as any).user.organizationId;

  if (!connectionId || !query) {
    return res.status(400).json({ success: false, error: "Missing required parameters." });
  }

  try {
    const controlDb = await getControlDb();
    const connColl = controlDb.collection("database_connections");

    const conn = connColl.findOne({ id: connectionId, organization_id: organizationId });

    if (!conn) {
      return res.status(404).json({ success: false, error: "Database connection not found or unauthorized." });
    }

    const jobsColl = controlDb.collection("query_jobs");
    const jobId = newId();

    jobsColl.insertOne({
      id: jobId,
      organizationId,
      connectionId,
      query,
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Start background worker
    const { startQueryJob } = require("./query-job");
    const jobPromise = startQueryJob(jobId, {
      connectionId,
      engine: conn.engine,
      query,
      organizationId,
    }).catch((err: any) => {
      console.error(`Background worker failed for job ${jobId}:`, err);
    });

    if (process.env.VERCEL === "1") {
      await jobPromise;
    }

    return res.json({ success: true, jobId });
  } catch (err: any) {
    console.error("Failed to enqueue job:", err);
    return res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

/**
 * Retrieve execution job status
 */
app.get("/api/query/status/:jobId", authMiddleware, async (req, res) => {
  const { jobId } = req.params;
  const organizationId = (req as any).user.organizationId;

  try {
    const controlDb = await getControlDb();
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
  } catch (err: any) {
    console.error(`[QUERY /status/${req.params.jobId}] Error:`, err.message || err);
    return res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

/**
 * Get a paginated chunk of query results
 */
app.get("/api/query/results/:jobId", authMiddleware, async (req, res) => {
  const { jobId } = req.params;
  const page = parseInt(req.query.page as string || "1", 10);
  const organizationId = (req as any).user.organizationId;
  const pageSize = 500;

  try {
    const controlDb = await getControlDb();
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
  } catch (err: any) {
    console.error(`[QUERY /results/${req.params.jobId}] Error:`, err.message || err);
    return res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Dedicated Node.js backend server listening on port ${PORT}`);
});
