import { Router, Response } from "express";
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import * as z from "zod";
import { getControlDb, newId } from "../json-db";
const router = Router();

// ---------------------------------------------------------------------------
// OpenRouter client
// ---------------------------------------------------------------------------

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";

if (!OPENROUTER_API_KEY) {
  console.warn("[CHAT] WARNING: OPENROUTER_API_KEY is not set. AI features will fail.");
}

const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: OPENROUTER_API_KEY,
  headers: {
    "HTTP-Referer": process.env.FRONTEND_URL || "http://localhost:3000",
    "X-Title": "BI-Lite",
  },
});

const DEFAULT_MODEL = "deepseek/deepseek-chat-v3-0324";

// ---------------------------------------------------------------------------
// Error extraction helper — digs through nested cause chains
// ---------------------------------------------------------------------------

function extractErrorMessage(err: any): string {
  // AI SDK errors often wrap the real error in a cause chain
  let message = err?.message || String(err);
  let cause = err?.cause;
  const messages: string[] = [message];

  // Walk the cause chain up to 5 levels deep
  let depth = 0;
  while (cause && depth < 5) {
    const causeMsg = cause?.message || String(cause);
    if (causeMsg && !messages.includes(causeMsg)) {
      messages.push(causeMsg);
    }
    cause = cause?.cause;
    depth++;
  }

  // Check for response body in AI SDK errors
  if (err?.responseBody) {
    try {
      const body = typeof err.responseBody === 'string' ? JSON.parse(err.responseBody) : err.responseBody;
      if (body?.error?.message) {
        messages.push(body.error.message);
      }
    } catch { }
  }

  // Check for data property (some AI SDK errors have this)
  if (err?.data?.error) {
    const dataErr = typeof err.data.error === 'string' ? err.data.error : err.data.error?.message;
    if (dataErr) messages.push(dataErr);
  }

  // Return the most informative message
  return messages.filter(Boolean).join(' | ');
}

// ---------------------------------------------------------------------------
// AI Response Schemas & Types
// ---------------------------------------------------------------------------

const SqlAiResponseSchema = z.object({
  sql: z.string().describe("A read-only SQL SELECT statement with no trailing semicolon. If blocking a destructive operation, leave this empty or write 'BLOCKED'."),
  chartType: z
    .enum(["LINE", "BAR", "DONUT", "TABLE", "AREA", "SCATTER", "ERROR"])
    .describe("The most appropriate chart type. MUST use ERROR if the user asks for a destructive operation (delete, drop, insert, update)."),
  chartTitle: z.string().describe("A concise, human-readable title for the chart (max 60 chars)."),
  xAxisKey: z.string().describe("The field name in the query result to use as the X axis or label."),
  yAxisKey: z
    .string()
    .describe("The primary field name in the query result to use as the default Y axis value."),
  yAxisKeys: z
    .array(z.string())
    .optional()
    .describe(
      "Optional. An array of multiple field names in the query result to plot as separate lines (for multi-line LINE charts)."
    ),
  reasoning: z
    .string()
    .describe(
      "1-2 sentence explanation of the query. If chartType is ERROR, this MUST contain the reason the query was blocked."
    ),
});

interface SchemaRow {
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

// ---------------------------------------------------------------------------
// Schema Formatters
// ---------------------------------------------------------------------------

function formatSqlSchemaForPrompt(rows: SchemaRow[]): string {
  const tables = new Map<string, SchemaRow[]>();
  for (const row of rows) {
    const key = `${row.tableSchema}.${row.tableName}`;
    const existing = tables.get(key);
    if (existing) {
      existing.push(row);
    } else {
      tables.set(key, [row]);
    }
  }

  const blocks: string[] = [];
  for (const [tableKey, cols] of tables) {
    const sorted = [...cols].sort((a, b) => a.ordinalPosition - b.ordinalPosition);
    const columnDefs = sorted
      .map((c) => {
        const pk = c.isPrimaryKey ? " PRIMARY KEY" : "";
        const nullable = c.isNullable ? "" : " NOT NULL";
        const samples = c.sampleValues && c.sampleValues.length > 0
          ? ` -- Sample values: ${c.sampleValues.slice(0, 5).join(", ")}`
          : "";
        return `  ${c.columnName} ${c.dataType.toUpperCase()}${pk}${nullable}${samples}`;
      })
      .join(",\n");
    blocks.push(`TABLE ${tableKey} (\n${columnDefs}\n);`);
  }

  return blocks.join("\n\n");
}

function formatMongoSchemaForPrompt(rows: SchemaRow[]): string {
  const collections = new Map<string, SchemaRow[]>();
  for (const row of rows) {
    const key = row.tableName;
    const existing = collections.get(key);
    if (existing) {
      existing.push(row);
    } else {
      collections.set(key, [row]);
    }
  }

  const blocks: string[] = [];
  for (const [collName, fields] of collections) {
    const sorted = [...fields].sort((a, b) => a.ordinalPosition - b.ordinalPosition);
    const fieldDefs = sorted
      .map((f) => {
        const pk = f.isPrimaryKey ? "  // primary key" : "";
        const samples = f.sampleValues && f.sampleValues.length > 0
          ? `  // Sample values: ${f.sampleValues.slice(0, 5).join(", ")}`
          : "";
        return `  ${f.columnName}: ${f.dataType}${pk}${samples}`;
      })
      .join(",\n");
    blocks.push(`COLLECTION ${collName} {\n${fieldDefs}\n}`);
  }

  return blocks.join("\n\n");
}

// ---------------------------------------------------------------------------
// Prompt Builders
// ---------------------------------------------------------------------------

function buildSqlSystemPrompt(schemaBlock: string): string {
  return `You are an expert SQL analyst and data visualization specialist. Your job is to translate natural language business questions into safe, read-only SQL queries and choose the optimal chart type for the result.

STRICT RULES — YOU MUST FOLLOW THESE OR THE RESPONSE WILL BE REJECTED:
1. Output ONLY a SELECT statement. Never write INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE, CREATE, GRANT, REVOKE, EXECUTE, CALL, or any DDL/DML.
2. If the user asks for ANY destructive operation (e.g., delete, drop, update, insert), you MUST NOT generate a SELECT query to show the data instead. You MUST reject the request entirely by returning exactly this JSON object instead of the standard output format: {"error": "Your explanation of why it is blocked"}
3. Do NOT include a trailing semicolon in the SQL string.
4. Do NOT use CTEs with non-read-only side effects.
5. Always LIMIT results to at most 500 rows unless the user explicitly asks for more.
6. Prefer qualified column names (table.column) to avoid ambiguity.
7. Use standard SQL-92 syntax compatible with PostgreSQL.

CHART SELECTION GUIDE:
- ERROR: MUST be used if the user asks for ANY destructive operation (e.g. drop, delete, insert, update). Provide the reason in "reasoning" and leave sql empty. Do NOT generate a placeholder SELECT query to show the data instead.
- LINE: Time-series data with a date/timestamp x-axis. Best for trends over time. If comparing multiple trend fields on the same X axis, include all comparison column names in "yAxisKeys" and put the primary one in "yAxisKey".
- BAR: Categorical comparisons (e.g. sales by region, counts by category). Best for ranking.
- DONUT: Part-of-whole relationships. Best when there are 2-8 distinct categories.
- AREA: Cumulative or stacked time-series. Best for showing volume over time.
- SCATTER: Correlation between two numeric variables.
- TABLE: Raw listing of rows, or when data has too many columns for a chart.

DATABASE SCHEMA:
\`\`\`sql
${schemaBlock}
\`\`\`

When choosing xAxisKey, yAxisKey, and optional yAxisKeys, use the EXACT column name (or alias) that will appear in the SQL result set.`;
}

function buildMongoSystemPrompt(schemaBlock: string): string {
  return `You are an expert MongoDB analyst and data visualization specialist. Translate the user's question into a MongoDB aggregation pipeline and choose the best chart type.

You MUST respond with ONLY a single valid JSON object — no markdown, no explanation, no extra text. The JSON must have exactly these keys:

{
  "collection": "<collection name from schema, or empty if ERROR>",
  "pipeline": [ ...aggregation stages... ],
  "chartType": "TABLE" | "BAR" | "LINE" | "DONUT" | "AREA" | "SCATTER" | "ERROR",
  "chartTitle": "<concise title, max 60 chars>",
  "xAxisKey": "<field name that will appear in result documents>",
  "yAxisKey": "<field name that will appear in result documents>",
  "yAxisKeys": ["<optional list of multiple field names for multi-line charts>"],
  "reasoning": "<1-2 sentence explanation>"
}

PIPELINE RULES:
- NEVER use write stages: $out, $merge
- NEVER use server-side JS: $where, $function, $accumulator
- Always include a $limit stage (max 500) unless the user asks for more
- Use field names EXACTLY as they appear in the schema
- If the user asks for ANY destructive operation (drop, delete, insert, update), you MUST reject it by returning exactly this JSON object instead of the one above: {"error": "Your explanation of why it is blocked"}. DO NOT generate a read-only query to show the data instead. You MUST abort and return the error JSON.

CHART SELECTION:
- ERROR: MUST be used if the user asks for ANY destructive operation (drop, delete, insert, update). Provide the reason in "reasoning" and leave pipeline empty []. Do NOT generate a read-only query to show the data instead.
- TABLE: listing raw documents / many fields (use this for simple "show me" queries)
- BAR: categorical comparisons
- LINE: time-series trends (supports multi-line by specifying "yAxisKeys" array of fields)
- DONUT: part-of-whole (2-8 categories)
- AREA: cumulative time-series
- SCATTER: correlation between two numeric fields

DATABASE SCHEMA:
\`\`\`
${schemaBlock}
\`\`\`

EXAMPLE — "show me 5 employees":
{"collection":"employees","pipeline":[{"$limit":5}],"chartType":"TABLE","chartTitle":"Employees","xAxisKey":"name","yAxisKey":"name","yAxisKeys":[],"reasoning":"Listing raw employee documents as a table."}`;
}

// ---------------------------------------------------------------------------
// Chat Sessions CRUD Routes
// ---------------------------------------------------------------------------

/**
 * GET /api/chat/sessions
 */
router.get("/sessions", async (req: any, res: Response) => {
  try {
    const organizationId = req.user.organizationId;
    const userId = req.user.userId || req.user.id;

    if (!organizationId || !userId) {
      return res.status(400).json({ error: "Missing authorization context." });
    }

    const controlDb = await getControlDb();
    const chatSessionsColl = controlDb.collection("chat_sessions");
    const chatMessagesColl = controlDb.collection("chat_messages");
    const connColl = controlDb.collection("database_connections");

    const sessions = chatSessionsColl.findMany(
      { organization_id: organizationId, user_id: userId },
      { sort: { updated_at: -1 }, limit: 50 }
    );

    const formatted = sessions.map((s) => {
      let title = s.title;
      const messages = chatMessagesColl.findMany({ session_id: s.id }, { sort: { created_at: 1 } });
      if (title === "New Chat" && messages.length > 0) {
        const firstMsgContent = messages[0].content;
        if (firstMsgContent) {
          title = firstMsgContent.slice(0, 20).trim() + (firstMsgContent.length > 20 ? "..." : "");
          chatSessionsColl.updateOne({ id: s.id }, { $set: { title } });
        }
      }
      const conn = s.connection_id ? connColl.findOne({ id: s.connection_id }) : null;
      return {
        id: s.id,
        title,
        connectionId: s.connection_id || null,
        connectionAlias: s.connection_alias || (conn ? conn.alias : "Deleted DB"),
        updatedAt: s.updated_at,
        createdAt: s.created_at,
        messageCount: messages.length,
      };
    });

    return res.json(formatted);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || String(err) });
  }
});

/**
 * GET /api/chat/sessions/search
 */
router.get("/sessions/search", async (req: any, res: Response) => {
  try {
    const organizationId = req.user.organizationId;
    const userId = req.user.userId || req.user.id;
    const query = (req.query.query as string) || "";

    if (!organizationId || !userId) {
      return res.status(400).json({ error: "Missing authorization context." });
    }

    const controlDb = await getControlDb();
    const chatSessionsColl = controlDb.collection("chat_sessions");
    const chatMessagesColl = controlDb.collection("chat_messages");

    const sessions = chatSessionsColl.findMany(
      {
        organization_id: organizationId,
        user_id: userId,
        title: { $regex: query, $options: "i" },
      },
      { sort: { updated_at: -1 }, limit: 20 }
    );

    const formatted = sessions.map((s) => {
      let title = s.title;
      const messages = chatMessagesColl.findMany({ session_id: s.id });
      if (title === "New Chat" && messages.length > 0) {
        const firstMsgContent = messages[0].content;
        if (firstMsgContent) {
          title = firstMsgContent.slice(0, 20).trim() + (firstMsgContent.length > 20 ? "..." : "");
          chatSessionsColl.updateOne({ id: s.id }, { $set: { title } });
        }
      }
      return {
        id: s.id,
        title,
        connectionId: s.connection_id || null,
        connectionAlias: s.connection_alias || "Deleted DB",
        updatedAt: s.updated_at,
        createdAt: s.created_at,
        messageCount: messages.length,
      };
    });

    return res.json(formatted);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || String(err) });
  }
});

/**
 * POST /api/chat/sessions
 */
router.post("/sessions", async (req: any, res: Response) => {
  try {
    const organizationId = req.user.organizationId;
    const userId = req.user.userId || req.user.id;
    const { connectionId, connectionAlias, title = "New Chat" } = req.body;

    if (!organizationId || !userId || !connectionId || !connectionAlias) {
      return res.status(400).json({ success: false, error: "Missing required parameters." });
    }

    const controlDb = await getControlDb();
    const connColl = controlDb.collection("database_connections");
    const chatSessionsColl = controlDb.collection("chat_sessions");

    const conn = connColl.findOne({ id: connectionId, organization_id: organizationId });

    if (!conn) {
      return res.status(404).json({ success: false, error: "Database connection not found." });
    }

    const sessionId = newId();
    chatSessionsColl.insertOne({
      id: sessionId,
      title,
      connection_id: connectionId,
      connection_alias: connectionAlias,
      organization_id: organizationId,
      user_id: userId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    return res.json({ success: true, sessionId });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

/**
 * PATCH /api/chat/sessions/:id
 */
router.patch("/sessions/:id", async (req: any, res: Response) => {
  try {
    const organizationId = req.user.organizationId;
    const userId = req.user.userId || req.user.id;
    const { id: sessionId } = req.params;
    const { title } = req.body;

    if (!organizationId || !userId || !sessionId || !title) {
      return res.status(400).json({ success: false, error: "Missing required parameters." });
    }

    const controlDb = await getControlDb();
    const chatSessionsColl = controlDb.collection("chat_sessions");

    const existing = chatSessionsColl.findOne({
      id: sessionId,
      organization_id: organizationId,
      user_id: userId,
    });

    if (!existing) {
      return res.status(404).json({ success: false, error: "Chat session not found or unauthorized." });
    }

    chatSessionsColl.updateOne({ id: sessionId }, { $set: { title, updated_at: new Date().toISOString() } });

    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

/**
 * DELETE /api/chat/sessions/:id
 */
router.delete("/sessions/:id", async (req: any, res: Response) => {
  try {
    const organizationId = req.user.organizationId;
    const userId = req.user.userId || req.user.id;
    const { id: sessionId } = req.params;

    if (!organizationId || !userId || !sessionId) {
      return res.status(400).json({ success: false, error: "Missing required parameters." });
    }

    const controlDb = await getControlDb();
    const chatSessionsColl = controlDb.collection("chat_sessions");
    const chatMessagesColl = controlDb.collection("chat_messages");

    const existing = chatSessionsColl.findOne({
      id: sessionId,
      organization_id: organizationId,
      user_id: userId,
    });

    if (!existing) {
      return res.status(404).json({ success: false, error: "Chat session not found or unauthorized." });
    }

    chatMessagesColl.deleteMany({ session_id: sessionId });
    chatSessionsColl.deleteOne({ id: sessionId });

    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

/**
 * GET /api/chat/sessions/:id/messages
 */
router.get("/sessions/:id/messages", async (req: any, res: Response) => {
  try {
    const organizationId = req.user.organizationId;
    const userId = req.user.userId || req.user.id;
    const { id: sessionId } = req.params;

    if (!organizationId || !userId || !sessionId) {
      return res.status(400).json({ error: "Missing required parameters." });
    }

    const controlDb = await getControlDb();
    const chatSessionsColl = controlDb.collection("chat_sessions");
    const chatMessagesColl = controlDb.collection("chat_messages");

    const existing = chatSessionsColl.findOne({
      id: sessionId,
      organization_id: organizationId,
      user_id: userId,
    });

    if (!existing) {
      return res.status(404).json({ error: "Chat session not found or unauthorized." });
    }

    const messages = chatMessagesColl.findMany(
      { session_id: sessionId },
      { sort: { created_at: 1 } }
    );

    const formatted = messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      chartResult: m.chart_result ?? undefined,
      createdAt: m.created_at,
    }));

    return res.json(formatted);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || String(err) });
  }
});

/**
 * POST /api/chat/sessions/:id/messages
 * Bulk-save/sync messages.
 */
router.post("/sessions/:id/messages", async (req: any, res: Response) => {
  try {
    const organizationId = req.user.organizationId;
    const userId = req.user.userId || req.user.id;
    const { id: sessionId } = req.params;
    const { messages } = req.body;

    if (!organizationId || !userId || !sessionId) {
      return res.status(400).json({ success: false, error: "Missing required parameters." });
    }

    const controlDb = await getControlDb();
    const chatSessionsColl = controlDb.collection("chat_sessions");
    const chatMessagesColl = controlDb.collection("chat_messages");

    const existing = chatSessionsColl.findOne({
      id: sessionId,
      organization_id: organizationId,
      user_id: userId,
    });

    if (!existing) {
      return res.status(404).json({ success: false, error: "Chat session not found or unauthorized." });
    }

    chatMessagesColl.deleteMany({ session_id: sessionId });

    if (messages && messages.length > 0) {
      chatMessagesColl.insertMany(
        messages.map((m: any) => ({
          session_id: sessionId,
          role: m.role,
          content: m.content,
          chart_result: m.chartResult || null,
          created_at: m.createdAt ? new Date(m.createdAt).toISOString() : new Date().toISOString(),
        }))
      );
    }

    chatSessionsColl.updateOne({ id: sessionId }, { $set: { updated_at: new Date().toISOString() } });

    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

// ---------------------------------------------------------------------------
// AI Completion ask Route
// ---------------------------------------------------------------------------

/**
 * POST /api/chat/ask
 * Ask OpenRouter AI a question to generate a SQL/Mongo query.
 */
router.post("/ask", async (req: any, res: Response) => {
  try {
    const organizationId = req.user.organizationId;
    const { connectionId, question, model: requestedModel } = req.body;
    const model = requestedModel || DEFAULT_MODEL;

    if (!organizationId || !connectionId || !question) {
      return res.status(400).json({ success: false, error: "Missing required parameters." });
    }

    const controlDb = await getControlDb();
    const connColl = controlDb.collection("database_connections");
    const schemaColl = controlDb.collection("schema_metadata");

    // Load connection
    const conn = connColl.findOne({
      id: connectionId,
      status: "CONNECTED",
      organization_id: organizationId,
    });

    if (!conn) {
      return res.status(404).json({
        success: false,
        error: "Connection not found or unauthorized.",
      });
    }

    // Load schema
    const schemaRows = schemaColl.findMany(
      { connection_id: connectionId },
      { sort: { ordinal_position: 1 } }
    );

    if (schemaRows.length === 0) {
      return res.status(400).json({
        success: false,
        error: "No schema metadata found. Introspect first.",
      });
    }

    const rows: SchemaRow[] = schemaRows.map((r) => ({
      tableSchema: r.table_schema,
      tableName: r.table_name,
      columnName: r.column_name,
      dataType: r.data_type,
      isNullable: r.is_nullable,
      isPrimaryKey: r.is_primary_key,
      columnDefault: r.column_default,
      ordinalPosition: r.ordinal_position,
      sampleValues: r.sample_values || null,
    }));

    if (conn.engine === "MONGODB") {
      const systemPrompt = buildMongoSystemPrompt(formatMongoSchemaForPrompt(rows));

      let result;
      try {
        result = await generateText({
          model: openrouter(model),
          system: systemPrompt,
          prompt: question,
          temperature: 0.1,
        });
      } catch (aiErr: any) {
        const errMsg = extractErrorMessage(aiErr);
        console.error(`[CHAT /ask] OpenRouter generateText (MongoDB) failed:`, errMsg);
        console.error(`[CHAT /ask] Full error:`, aiErr);
        return res.status(502).json({
          success: false,
          error: `AI service error: ${errMsg}`,
        });
      }

      const rawText = result.text.trim();
      let jsonStr = rawText;
      const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fenceMatch) {
        jsonStr = fenceMatch[1].trim();
      }

      let parsed: any;
      try {
        parsed = JSON.parse(jsonStr);
      } catch (e) {
        console.error(`[CHAT /ask] AI returned invalid MongoDB JSON. Raw (first 500 chars):`, jsonStr.slice(0, 500));
        return res.status(400).json({
          success: false,
          error: `AI returned invalid MongoDB JSON: ${String(e)}. Raw: ${jsonStr.slice(0, 200)}`,
        });
      }

      if (parsed.error || parsed.chartType === "ERROR") {
        return res.status(400).json({
          success: false,
          error: parsed.error || parsed.reasoning || "Execution blocked: Destructive operation requested.",
        });
      }

      if (!parsed.collection || !Array.isArray(parsed.pipeline)) {
        console.error(`[CHAT /ask] AI response missing collection or pipeline:`, JSON.stringify(parsed).slice(0, 500));
        return res.status(400).json({
          success: false,
          error: `AI response missing collection or pipeline.`,
        });
      }

      const mongoPayload = JSON.stringify({
        collection: parsed.collection,
        pipeline: parsed.pipeline,
      });

      const VALID_CHART_TYPES = ["LINE", "BAR", "DONUT", "TABLE", "AREA", "SCATTER", "ERROR"] as const;
      const chartType = VALID_CHART_TYPES.includes(parsed.chartType) ? parsed.chartType : "TABLE";

      return res.json({
        success: true,
        response: {
          sql: mongoPayload,
          chartType,
          chartTitle: parsed.chartTitle || "Query Result",
          xAxisKey: parsed.xAxisKey || "_id",
          yAxisKey: parsed.yAxisKey || "_id",
          yAxisKeys: Array.isArray(parsed.yAxisKeys) ? parsed.yAxisKeys : undefined,
          reasoning: parsed.reasoning || "",
        },
        connectionId,
      });
    }

    // SQL path — use generateText + JSON parsing for broad OpenRouter model compatibility
    const sqlSystemPrompt = buildSqlSystemPrompt(formatSqlSchemaForPrompt(rows))
      + `\n\nYou MUST respond with ONLY a single valid JSON object — no markdown, no explanation, no extra text. The JSON must have exactly these keys:\n{\n  "sql": "<SELECT statement with no trailing semicolon>",\n  "chartType": "LINE" | "BAR" | "DONUT" | "TABLE" | "AREA" | "SCATTER" | "ERROR",\n  "chartTitle": "<concise title, max 60 chars>",\n  "xAxisKey": "<field name for X axis>",\n  "yAxisKey": "<primary field name for Y axis>",\n  "yAxisKeys": ["<optional additional Y axis field names>"],\n  "reasoning": "<1-2 sentence explanation>"\n}`;

    let sqlResult;
    try {
      sqlResult = await generateText({
        model: openrouter(model),
        system: sqlSystemPrompt,
        prompt: question,
        temperature: 0.1,
      });
    } catch (aiErr: any) {
      const errMsg = extractErrorMessage(aiErr);
      console.error(`[CHAT /ask] OpenRouter generateText (SQL) failed:`, errMsg);
      console.error(`[CHAT /ask] Full error:`, aiErr);
      return res.status(502).json({
        success: false,
        error: `AI service error: ${errMsg}`,
      });
    }

    const sqlRawText = sqlResult.text.trim();
    let sqlJsonStr = sqlRawText;
    const sqlFenceMatch = sqlRawText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (sqlFenceMatch) {
      sqlJsonStr = sqlFenceMatch[1].trim();
    }

    let object: any;
    try {
      object = JSON.parse(sqlJsonStr);
    } catch (e) {
      console.error(`[CHAT /ask] AI returned invalid SQL JSON. Raw (first 500 chars):`, sqlJsonStr.slice(0, 500));
      return res.status(400).json({
        success: false,
        error: `AI returned invalid JSON: ${String(e)}. Raw: ${sqlJsonStr.slice(0, 200)}`,
      });
    }

    // Handle error/blocked response from AI
    if (object.error || object.chartType === "ERROR") {
      return res.status(400).json({
        success: false,
        error: object.error || object.reasoning || "Execution blocked: Destructive operation requested.",
      });
    }

    // Validate required fields
    const VALID_CHART_TYPES_SQL = ["LINE", "BAR", "DONUT", "TABLE", "AREA", "SCATTER", "ERROR"] as const;
    const sqlChartType = VALID_CHART_TYPES_SQL.includes(object.chartType) ? object.chartType : "TABLE";

    const response = {
      sql: object.sql || "",
      chartType: sqlChartType,
      chartTitle: object.chartTitle || "Query Result",
      xAxisKey: object.xAxisKey || "",
      yAxisKey: object.yAxisKey || "",
      yAxisKeys: Array.isArray(object.yAxisKeys) ? object.yAxisKeys : undefined,
      reasoning: object.reasoning || "",
    };

    return res.json({
      success: true,
      response,
      connectionId,
    });
  } catch (err: any) {
    const errMsg = extractErrorMessage(err);
    console.error(`[CHAT /ask] Unhandled error:`, errMsg);
    console.error(`[CHAT /ask] Stack:`, err.stack || err);
    return res.status(500).json({ success: false, error: errMsg });
  }
});

/**
 * POST /api/chat/generate-title
 * Generate a chat title using OpenRouter AI.
 */
router.post("/generate-title", async (req: any, res: Response) => {
  try {
    const { firstMessage, model: requestedModel } = req.body;
    if (!firstMessage) {
      return res.status(400).json({ error: "Missing firstMessage." });
    }

    const model = requestedModel || DEFAULT_MODEL;
    const fallback = firstMessage.slice(0, 40).trim() + (firstMessage.length > 40 ? "…" : "");
    try {
      const result = await generateText({
        model: openrouter(model),
        system:
          "Generate a concise 4-6 word title for a chat conversation based on the user's first message. Output ONLY the title — no quotes, no punctuation at the end, no explanation.",
        prompt: firstMessage,
        temperature: 0.3,
      });
      const title = result.text.trim().replace(/^["']|["']$/g, "").slice(0, 60);
      return res.json({ title: title || fallback });
    } catch (titleErr: any) {
      console.error(`[CHAT /generate-title] AI call failed, using fallback:`, extractErrorMessage(titleErr));
      return res.json({ title: fallback });
    }
  } catch (err: any) {
    console.error(`[CHAT /generate-title] Unhandled error:`, extractErrorMessage(err));
    return res.status(500).json({ error: extractErrorMessage(err) });
  }
});

/**
 * POST /api/chat/ask-upload
 * Answer a question about uploaded CSV/JSON data using AI.
 */
router.post("/ask-upload", async (req: any, res: Response) => {
  try {
    const { uploadId, question, model: requestedModel, columns, sampleRows } = req.body;
    const model = requestedModel || DEFAULT_MODEL;

    if (!question || !columns || !sampleRows) {
      return res.status(400).json({ success: false, error: "Missing required parameters." });
    }

    const dataSchema = `UPLOADED DATA COLUMNS:\n${columns.join(", ")}\n\nSAMPLE ROWS (first 5):\n${JSON.stringify(sampleRows.slice(0, 5), null, 2)}`;

    const systemPrompt = `You are a data analyst. The user has uploaded a dataset. Analyze the data and answer their question.

${dataSchema}

Respond with a JSON object:
{
  "chartType": "TABLE" | "BAR" | "LINE" | "DONUT" | "AREA" | "SCATTER",
  "chartTitle": "<concise title, max 60 chars>",
  "xAxisKey": "<column name for X axis>",
  "yAxisKey": "<column name for Y axis>",
  "yAxisKeys": ["<optional additional Y axis columns>"],
  "reasoning": "<1-2 sentence explanation>",
  "filteredRows": [<array of row objects to display — max 500 rows, filtered/aggregated if needed>]
}

RULES:
- Use EXACT column names from the data
- For aggregation questions, compute the aggregation in filteredRows
- filteredRows must be a valid JSON array of objects
- Respond with ONLY the JSON, no extra text`;

    let result;
    try {
      result = await generateText({
        model: openrouter(model),
        system: systemPrompt,
        prompt: question,
        temperature: 0.1,
      });
    } catch (aiErr: any) {
      const errMsg = extractErrorMessage(aiErr);
      console.error(`[CHAT /ask-upload] OpenRouter generateText failed:`, errMsg);
      console.error(`[CHAT /ask-upload] Full error:`, aiErr);
      return res.status(502).json({
        success: false,
        error: `AI service error: ${errMsg}`,
      });
    }

    const rawText = result.text.trim();
    let jsonStr = rawText;
    const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();

    let parsed: any;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      console.error(`[CHAT /ask-upload] AI returned invalid JSON. Raw (first 500 chars):`, jsonStr.slice(0, 500));
      return res.status(400).json({
        success: false,
        error: `AI returned invalid JSON: ${String(e)}`,
      });
    }

    const VALID_CHART_TYPES = ["LINE", "BAR", "DONUT", "TABLE", "AREA", "SCATTER"] as const;
    const chartType = VALID_CHART_TYPES.includes(parsed.chartType) ? parsed.chartType : "TABLE";

    return res.json({
      success: true,
      response: {
        sql: `upload:${uploadId}`,
        chartType,
        chartTitle: parsed.chartTitle || "Data Analysis",
        xAxisKey: parsed.xAxisKey || columns[0],
        yAxisKey: parsed.yAxisKey || columns[1] || columns[0],
        yAxisKeys: Array.isArray(parsed.yAxisKeys) ? parsed.yAxisKeys : undefined,
        reasoning: parsed.reasoning || "",
      },
      rows: parsed.filteredRows || sampleRows,
      columns,
    });
  } catch (err: any) {
    const errMsg = extractErrorMessage(err);
    console.error(`[CHAT /ask-upload] Unhandled error:`, errMsg);
    console.error(`[CHAT /ask-upload] Stack:`, err.stack || err);
    return res.status(500).json({ success: false, error: errMsg });
  }
});

/**
 * POST /api/chat/ask-upload
 * Answer a question about uploaded CSV/JSON data using AI.
 */
router.post("/ask-upload", async (req: any, res: Response) => {
  try {
    const { uploadId, question, model: requestedModel, columns, sampleRows } = req.body;
    const model = requestedModel || DEFAULT_MODEL;

    if (!question || !columns || !sampleRows) {
      return res.status(400).json({ success: false, error: "Missing required parameters." });
    }

    const dataSchema = `UPLOADED DATA COLUMNS:\n${columns.join(", ")}\n\nSAMPLE ROWS (first 5):\n${JSON.stringify(sampleRows.slice(0, 5), null, 2)}`;

    const systemPrompt = `You are a data analyst. The user has uploaded a dataset. Analyze the data and answer their question.

${dataSchema}

Respond with a JSON object:
{
  "chartType": "TABLE" | "BAR" | "LINE" | "DONUT" | "AREA" | "SCATTER",
  "chartTitle": "<concise title, max 60 chars>",
  "xAxisKey": "<column name for X axis>",
  "yAxisKey": "<column name for Y axis>",
  "yAxisKeys": ["<optional additional Y axis columns>"],
  "reasoning": "<1-2 sentence explanation>",
  "filteredRows": [<array of row objects to display — max 500 rows, filtered/aggregated if needed>]
}

RULES:
- Use EXACT column names from the data
- For aggregation questions, compute the aggregation in filteredRows
- filteredRows must be a valid JSON array of objects
- Respond with ONLY the JSON, no extra text`;

    let result;
    try {
      result = await generateText({
        model: openrouter(model),
        system: systemPrompt,
        prompt: question,
        temperature: 0.1,
      });
    } catch (aiErr: any) {
      const errMsg = extractErrorMessage(aiErr);
      console.error(`[CHAT /ask-upload] OpenRouter generateText failed:`, errMsg);
      console.error(`[CHAT /ask-upload] Full error:`, aiErr);
      return res.status(502).json({
        success: false,
        error: `AI service error: ${errMsg}`,
      });
    }

    const rawText = result.text.trim();
    let jsonStr = rawText;
    const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();

    let parsed: any;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      console.error(`[CHAT /ask-upload] AI returned invalid JSON. Raw (first 500 chars):`, jsonStr.slice(0, 500));
      return res.status(400).json({
        success: false,
        error: `AI returned invalid JSON: ${String(e)}`,
      });
    }

    const VALID_CHART_TYPES = ["LINE", "BAR", "DONUT", "TABLE", "AREA", "SCATTER"] as const;
    const chartType = VALID_CHART_TYPES.includes(parsed.chartType) ? parsed.chartType : "TABLE";

    return res.json({
      success: true,
      response: {
        sql: `upload:${uploadId}`,
        chartType,
        chartTitle: parsed.chartTitle || "Data Analysis",
        xAxisKey: parsed.xAxisKey || columns[0],
        yAxisKey: parsed.yAxisKey || columns[1] || columns[0],
        yAxisKeys: Array.isArray(parsed.yAxisKeys) ? parsed.yAxisKeys : undefined,
        reasoning: parsed.reasoning || "",
      },
      rows: parsed.filteredRows || sampleRows,
      columns,
    });
  } catch (err: any) {
    const errMsg = extractErrorMessage(err);
    console.error(`[CHAT /ask-upload] Unhandled error:`, errMsg);
    console.error(`[CHAT /ask-upload] Stack:`, err.stack || err);
    return res.status(500).json({ success: false, error: errMsg });
  }
});

export default router;
