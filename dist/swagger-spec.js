"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.swaggerDocument = void 0;
exports.swaggerDocument = {
    openapi: "3.0.0",
    info: {
        title: "BI-Lite Dedicated Backend API",
        version: "1.0.0",
        description: "API documentation for the dedicated database execution and query pooling backend of BI-Lite.",
    },
    servers: [
        {
            url: "http://localhost:3002",
            description: "Local Development Server",
        },
    ],
    components: {
        securitySchemes: {
            BearerAuth: {
                type: "http",
                scheme: "bearer",
                bearerFormat: "JWT",
                description: "Enter your signed JWT backend token to authenticate.",
            },
        },
    },
    security: [
        {
            BearerAuth: [],
        },
    ],
    paths: {
        "/health": {
            get: {
                summary: "Retrieve server health",
                description: "Checks if the server is healthy and returns the current timestamp.",
                security: [], // No auth needed
                responses: {
                    200: {
                        description: "Success",
                        content: {
                            "application/json": {
                                schema: {
                                    type: "object",
                                    properties: {
                                        status: { type: "string", example: "healthy" },
                                        timestamp: { type: "string", example: "2026-06-08T05:00:00.000Z" },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
        "/api/connection/test": {
            post: {
                summary: "Test database connection",
                description: "Tests connectivity to a PostgreSQL or MongoDB database using transient setup credentials.",
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                properties: {
                                    engine: { type: "string", enum: ["POSTGRESQL", "MONGODB"], example: "POSTGRESQL" },
                                    host: { type: "string", example: "localhost" },
                                    port: { type: "integer", example: 5432 },
                                    dbName: { type: "string", example: "my_db" },
                                    dbUser: { type: "string", example: "postgres" },
                                    password: { type: "string", example: "secret" },
                                    sslEnabled: { type: "boolean", example: false },
                                    connectionUri: { type: "string", example: "mongodb://localhost:27017/my_db" },
                                },
                            },
                        },
                    },
                },
                responses: {
                    200: {
                        description: "Connection test outcome",
                        content: {
                            "application/json": {
                                schema: {
                                    type: "object",
                                    properties: {
                                        success: { type: "boolean", example: true },
                                        latencyMs: { type: "integer", example: 120 },
                                        serverVersion: { type: "string", example: "PostgreSQL 15.2" },
                                        error: { type: "string", example: "Connection refused" },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
        "/api/connection/introspect": {
            post: {
                summary: "Transient schema introspection",
                description: "Introspects a database dynamically before saving it, returning the list of tables and columns.",
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                properties: {
                                    engine: { type: "string", enum: ["POSTGRESQL", "MONGODB"], example: "POSTGRESQL" },
                                    host: { type: "string", example: "localhost" },
                                    port: { type: "integer", example: 5432 },
                                    dbName: { type: "string", example: "my_db" },
                                    dbUser: { type: "string", example: "postgres" },
                                    password: { type: "string", example: "secret" },
                                    sslEnabled: { type: "boolean", example: false },
                                    connectionUri: { type: "string", example: "mongodb://localhost:27017/my_db" },
                                },
                            },
                        },
                    },
                },
                responses: {
                    200: {
                        description: "List of tables and discovered columns",
                        content: {
                            "application/json": {
                                schema: {
                                    type: "object",
                                    properties: {
                                        success: { type: "boolean", example: true },
                                        tables: { type: "array", items: { type: "string" }, example: ["public.users", "public.orders"] },
                                        columns: {
                                            type: "array",
                                            items: {
                                                type: "object",
                                                properties: {
                                                    tableSchema: { type: "string", example: "public" },
                                                    tableName: { type: "string", example: "users" },
                                                    columnName: { type: "string", example: "email" },
                                                    dataType: { type: "string", example: "varchar" },
                                                    isNullable: { type: "boolean", example: false },
                                                    isPrimaryKey: { type: "boolean", example: false },
                                                    columnDefault: { type: "string", nullable: true, example: null },
                                                    ordinalPosition: { type: "integer", example: 2 },
                                                },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
        "/api/introspection/run": {
            post: {
                summary: "Introspect saved connection",
                description: "Introspects schema columns incrementally and saves them in the control plane MongoDB for a saved connection ID.",
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                properties: {
                                    connectionId: { type: "string", example: "6657bfb1a51187428169e001" },
                                },
                            },
                        },
                    },
                },
                responses: {
                    200: {
                        description: "Sync outcome",
                        content: {
                            "application/json": {
                                schema: {
                                    type: "object",
                                    properties: {
                                        success: { type: "boolean", example: true },
                                        tablesCount: { type: "integer", example: 12 },
                                        error: { type: "string", example: "Unauthorized" },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
        "/api/query/execute": {
            post: {
                summary: "Execute an analytical query asynchronously",
                description: "Starts a background query execution job and enqueues it, returning a jobId instantly.",
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                properties: {
                                    connectionId: { type: "string", example: "6657bfb1a51187428169e001" },
                                    engine: { type: "string", enum: ["POSTGRESQL", "MONGODB"], example: "POSTGRESQL" },
                                    query: { type: "string", example: "SELECT * FROM public.orders LIMIT 100" },
                                },
                            },
                        },
                    },
                },
                responses: {
                    200: {
                        description: "Enqueue outcome",
                        content: {
                            "application/json": {
                                schema: {
                                    type: "object",
                                    properties: {
                                        success: { type: "boolean", example: true },
                                        jobId: { type: "string", example: "6657bfb1a51187428169f999" },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
        "/api/query/status/{jobId}": {
            get: {
                summary: "Check query job execution status",
                description: "Returns the current state of a background query execution job.",
                parameters: [
                    {
                        name: "jobId",
                        in: "path",
                        required: true,
                        schema: { type: "string" },
                        example: "6657bfb1a51187428169f999",
                    },
                ],
                responses: {
                    200: {
                        description: "Current status details",
                        content: {
                            "application/json": {
                                schema: {
                                    type: "object",
                                    properties: {
                                        success: { type: "boolean", example: true },
                                        status: { type: "string", enum: ["pending", "processing", "completed", "failed"], example: "completed" },
                                        rowCount: { type: "integer", example: 1520 },
                                        columns: { type: "array", items: { type: "string" }, example: ["id", "amount", "status"] },
                                        durationMs: { type: "integer", example: 450 },
                                        error: { type: "string", nullable: true, example: null },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
        "/api/query/results/{jobId}": {
            get: {
                summary: "Get a paginated chunk of query results",
                description: "Returns a page of 500 rows for a completed query job.",
                parameters: [
                    {
                        name: "jobId",
                        in: "path",
                        required: true,
                        schema: { type: "string" },
                        example: "6657bfb1a51187428169f999",
                    },
                    {
                        name: "page",
                        in: "query",
                        required: false,
                        schema: { type: "integer", default: 1 },
                        example: 1,
                    },
                ],
                responses: {
                    200: {
                        description: "Paginated rows",
                        content: {
                            "application/json": {
                                schema: {
                                    type: "object",
                                    properties: {
                                        success: { type: "boolean", example: true },
                                        rows: {
                                            type: "array",
                                            items: { type: "object" },
                                            example: [{ id: 1, amount: 250, status: "completed" }],
                                        },
                                        pageNum: { type: "integer", example: 1 },
                                        totalPages: { type: "integer", example: 4 },
                                        rowCount: { type: "integer", example: 1520 },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
    },
};
