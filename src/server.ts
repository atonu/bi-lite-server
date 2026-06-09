import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";
import swaggerUi from "swagger-ui-express";

// Load environment variables (look in server root first, then fall back to parent monorepo folder)
dotenv.config({ path: path.join(__dirname, "../.env") });
dotenv.config({ path: path.join(__dirname, "../../.env") });

import { getControlDb, startQueryJob } from "./query-job";
import { runIntrospection, introspectTransientSchema } from "./introspection";
import { getPgPool, getMongoClient } from "./pool-manager";
import { swaggerDocument } from "./swagger-spec";

import cookieParser from "cookie-parser";
import authRouter from "./routes/auth";

const app = express();
const PORT = process.env.BACKEND_PORT || 3002;
const BACKEND_SECRET = process.env.BACKEND_SECRET || "bi-lite-backend-secret-key-super-secure-87654321";

app.use(cors({ origin: process.env.FRONTEND_URL || "http://localhost:3000", credentials: true }));
app.use(express.json());
app.use(cookieParser());

// Serve Swagger UI API documentation
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
    html {
      box-sizing: border-box;
      overflow: -moz-scrollbars-vertical;
      overflow-y: scroll;
    }
    *, *:before, *:after {
      box-sizing: inherit;
    }
    body {
      margin: 0;
      background: #fafafa;
    }
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
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIStandalonePreset
        ],
        plugins: [
          SwaggerUIBundle.plugins.DownloadUrl
        ],
        layout: "StandaloneLayout"
      });
      window.ui = ui;
    };
  </script>
</body>
</html>`);
});

// Mount auth routes
app.use("/api/auth", authRouter);

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
    const decoded = jwt.verify(token, BACKEND_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: "Invalid or expired authorization token." });
  }
};

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * Health check endpoint
 */
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
      if (!creds.connectionUri) {
        return res.status(400).json({ success: false, error: "Connection URI required." });
      }
      const client = await getMongoClient({
        id: "temp-test",
        engine: "MONGODB",
        decryptedUri: creds.connectionUri,
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
  const creds = req.body;
  const result = await introspectTransientSchema(creds);
  return res.json(result);
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
  const { connectionId, engine, query } = req.body;
  const organizationId = (req as any).user.organizationId;

  if (!connectionId || !engine || !query) {
    return res.status(400).json({ success: false, error: "Missing required parameters." });
  }

  try {
    const controlDb = await getControlDb();
    const jobsColl = controlDb.collection("query_jobs");

    const job = await jobsColl.insertOne({
      organizationId,
      connectionId,
      query,
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const jobId = job.insertedId.toString();

    // Start background worker, do not await it
    startQueryJob(jobId, {
      connectionId,
      engine,
      query,
      organizationId,
    }).catch((err) => {
      console.error(`Background worker failed for job ${jobId}:`, err);
    });

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
    const job = await controlDb.collection("query_jobs").findOne({
      _id: new ObjectId(jobId),
      organizationId,
    });

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
  const pageSize = 500; // Keep in sync with query-job.ts

  try {
    const controlDb = await getControlDb();
    const job = await controlDb.collection("query_jobs").findOne({
      _id: new ObjectId(jobId),
      organizationId,
    });

    if (!job) {
      return res.status(404).json({ success: false, error: "Query job not found." });
    }

    if (job.status !== "completed") {
      return res.status(400).json({
        success: false,
        error: `Results are not ready. Job status: ${job.status}`,
      });
    }

    const resultDoc = await controlDb.collection("query_job_results").findOne({
      jobId: new ObjectId(jobId),
      pageNum: page,
    });

    const totalPages = Math.ceil((job.rowCount || 0) / pageSize);

    return res.json({
      success: true,
      rows: resultDoc?.rows || [],
      pageNum: page,
      totalPages: totalPages === 0 ? 1 : totalPages,
      rowCount: job.rowCount || 0,
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Dedicated Node.js backend server listening on port ${PORT}`);
});
