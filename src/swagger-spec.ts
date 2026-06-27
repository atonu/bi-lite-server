export const swaggerDocument = {
  openapi: "3.0.0",
  info: {
    title: "BI-Lite Dedicated Backend API",
    version: "1.0.0",
    description: "API documentation for the dedicated database execution and query pooling backend of BI-Lite.",
  },
  servers: [
    {
      url: "https://bi-lite-server.vercel.app",
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
    // -------------------------------------------------------------------------
    // Health
    // -------------------------------------------------------------------------
    "/health": {
      get: {
        tags: ["System"],
        summary: "Server health check",
        description: "Returns server health status and timestamp.",
        security: [],
        responses: {
          200: {
            description: "Server is healthy",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", example: "healthy" },
                    timestamp: { type: "string", example: "2026-06-22T09:00:00.000Z" },
                  },
                },
              },
            },
          },
        },
      },
    },

    // -------------------------------------------------------------------------
    // Auth — Register
    // -------------------------------------------------------------------------
    "/api/auth/register": {
      post: {
        tags: ["Auth"],
        summary: "Register a new user",
        description: "Creates a new user and their personal organization. If a `prospectId` is supplied (from the onboarding flow) the pending prospect record is cleaned up.",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["email", "password", "name"],
                properties: {
                  email: { type: "string", format: "email", example: "john@example.com" },
                  password: { type: "string", minLength: 8, example: "myPassword123" },
                  name: { type: "string", example: "John Doe" },
                  prospectId: { type: "string", description: "Optional — GUID from onboarding set-password URL", example: "a1b2c3d4-..." },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "User registered successfully",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean", example: true },
                    message: { type: "string", example: "User registered successfully." },
                  },
                },
              },
            },
          },
          400: { description: "Missing fields or user already exists" },
          500: { description: "Internal server error" },
        },
      },
    },

    // -------------------------------------------------------------------------
    // Auth — Login
    // -------------------------------------------------------------------------
    "/api/auth/login": {
      post: {
        tags: ["Auth"],
        summary: "Login",
        description: "Authenticates a user, returns an access token in the response body and sets a `refreshToken` HTTP-only cookie.",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["email", "password"],
                properties: {
                  email: { type: "string", format: "email", example: "john@example.com" },
                  password: { type: "string", example: "myPassword123" },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Login successful",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean", example: true },
                    accessToken: { type: "string", example: "eyJhbGciOi..." },
                    user: {
                      type: "object",
                      properties: {
                        id: { type: "string", example: "uuid-v4" },
                        name: { type: "string", example: "John Doe" },
                        email: { type: "string", example: "john@example.com" },
                        role: { type: "string", example: "MEMBER" },
                        avatarUrl: { type: "string", nullable: true, example: null },
                      },
                    },
                  },
                },
              },
            },
          },
          401: { description: "Invalid credentials" },
          500: { description: "Internal server error" },
        },
      },
    },

    // -------------------------------------------------------------------------
    // Auth — Refresh Token
    // -------------------------------------------------------------------------
    "/api/auth/refresh-token": {
      post: {
        tags: ["Auth"],
        summary: "Refresh access token",
        description: "Issues a new access token using the `refreshToken` HTTP-only cookie. No request body needed.",
        security: [],
        responses: {
          200: {
            description: "New access token",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean", example: true },
                    accessToken: { type: "string", example: "eyJhbGciOi..." },
                  },
                },
              },
            },
          },
          401: { description: "No or invalid refresh token" },
        },
      },
    },

    // -------------------------------------------------------------------------
    // Auth — Forgot Password
    // -------------------------------------------------------------------------
    "/api/auth/forgot-password": {
      post: {
        tags: ["Auth"],
        summary: "Request password reset",
        description: "Sends a password reset link to the provided email. In dev mode the link is printed to the server console if SMTP is not configured.",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["email"],
                properties: {
                  email: { type: "string", format: "email", example: "john@example.com" },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Reset link sent (or silently skipped if user not found)",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean", example: true },
                    message: { type: "string", example: "If the email is registered, a reset link was sent." },
                  },
                },
              },
            },
          },
          400: { description: "Email is required" },
        },
      },
    },

    // -------------------------------------------------------------------------
    // Auth — Reset Password
    // -------------------------------------------------------------------------
    "/api/auth/reset-password": {
      post: {
        tags: ["Auth"],
        summary: "Reset password with token",
        description: "Validates the reset token (1-hour expiry) and updates the user's password.",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["token", "password"],
                properties: {
                  token: { type: "string", example: "abc123resettoken" },
                  password: { type: "string", minLength: 8, example: "newPassword123" },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Password reset successfully",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean", example: true },
                    message: { type: "string", example: "Password has been successfully reset." },
                  },
                },
              },
            },
          },
          400: { description: "Invalid or expired token" },
        },
      },
    },

    // -------------------------------------------------------------------------
    // Auth — Logout
    // -------------------------------------------------------------------------
    "/api/auth/logout": {
      post: {
        tags: ["Auth"],
        summary: "Logout",
        description: "Clears the `refreshToken` cookie and invalidates the stored refresh token.",
        responses: {
          200: {
            description: "Logged out",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean", example: true },
                    message: { type: "string", example: "Logged out." },
                  },
                },
              },
            },
          },
        },
      },
    },

    // -------------------------------------------------------------------------
    // Auth — Update display name
    // -------------------------------------------------------------------------
    "/api/auth/user": {
      put: {
        tags: ["Auth"],
        summary: "Update display name",
        description: "Updates the authenticated user's display name.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                properties: {
                  name: { type: "string", example: "Jane Doe" },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Name updated",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean", example: true },
                    name: { type: "string", example: "Jane Doe" },
                  },
                },
              },
            },
          },
          400: { description: "Name is required" },
          401: { description: "Unauthorized" },
        },
      },
    },

    // -------------------------------------------------------------------------
    // Onboarding
    // -------------------------------------------------------------------------
    "/api/onboard": {
      post: {
        tags: ["Onboarding"],
        summary: "Onboard a user from an external system",
        description: "Public endpoint. Creates a prospect record for a new user and returns a set-password URL, or returns a login URL if the user already exists. Database connection details can optionally be supplied to be auto-provisioned upon password setup.",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name", "email"],
                properties: {
                  name: { type: "string", example: "Alice Smith" },
                  email: { type: "string", format: "email", example: "alice@email.com" },
                  siteUrl: { type: "string", format: "uri", description: "Optional site URL to target for generated redirection URL", example: "http://localhost:3000" },
                  database: {
                    type: "array",
                    nullable: true,
                    description: "Optional array of database connections to create upon user registration (can be null or empty array)",
                    items: {
                      type: "object",
                      required: ["name", "engine"],
                      properties: {
                        name: { type: "string", example: "mongo test" },
                        engine: { type: "integer", enum: [0, 1, 2], description: "Database engine: 0 for Mongo, 1 for Postgres, 2 for MySQL", example: 0 },
                        connectionString: { type: "string", example: "mongodb+srv://atonuzahin_db_user:2wsxXSW@dataview.fdlu509.mongodb.net/bilite-test" },
                        connectionUri: { type: "string", example: "mongodb+srv://atonuzahin_db_user:2wsxXSW@dataview.fdlu509.mongodb.net/bilite-test" },
                        host: { type: "string", example: "localhost" },
                        hostname: { type: "string", example: "localhost" },
                        port: { type: "integer", example: 27017 },
                        dbName: { type: "string", example: "bilite-test" },
                        dbUser: { type: "string", example: "atonuzahin_db_user" },
                        password: { type: "string", example: "2wsxXSW" },
                        ssl: { type: "boolean", example: true },
                        sslEnabled: { type: "boolean", example: true },
                        tables: {
                          type: "array",
                          items: { type: "string" },
                          example: ["users", "orders"],
                        },
                      },
                    },
                  },
                },
                example: {
                  name: "Alice Smith",
                  email: "alice@email.com",
                  database: [
                    {
                      name: "mongo test",
                      engine: 0,
                      connectionString: "mongodb+srv://atonuzahin_db_user:2wsxXSW@dataview.fdlu509.mongodb.net/bilite-test",
                      tables: ["users", "orders"]
                    }
                  ]
                }
              },
            },
          },
        },
        responses: {
          200: {
            description: "Prospect created or existing user found",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    existingUser: { type: "boolean", example: false },
                    redirectionUrl: { type: "string", example: "http://localhost:3000/set-password/uuid-v4" },
                    message: { type: "string" },
                  },
                },
              },
            },
          },
          400: { description: "name and email are required" },
        },
      },
    },
    "/api/onboard/prospect/{id}": {
      get: {
        tags: ["Onboarding"],
        summary: "Get prospect user info",
        description: "Returns the name and email for a prospect ID (used by the set-password page).",
        security: [],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
            example: "uuid-v4",
          },
        ],
        responses: {
          200: {
            description: "Prospect info",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    name: { type: "string", example: "Alice Smith" },
                    email: { type: "string", example: "alice@email.com" },
                  },
                },
              },
            },
          },
          404: { description: "Prospect not found" },
        },
      },
    },

    // -------------------------------------------------------------------------
    // Connections
    // -------------------------------------------------------------------------
    "/api/connection/test": {
      post: {
        tags: ["Connections"],
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
        tags: ["Connections"],
        summary: "Transient schema introspection",
        description: "Introspects a database dynamically before saving, returning its tables and columns.",
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
            description: "Discovered schema",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean", example: true },
                    tables: { type: "array", items: { type: "string" } },
                    columns: { type: "array", items: { type: "object" } },
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
        tags: ["Connections"],
        summary: "Introspect a saved connection",
        description: "Introspects and caches the schema for a saved connection ID.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  connectionId: { type: "string", example: "uuid-v4" },
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
                  },
                },
              },
            },
          },
        },
      },
    },

    // -------------------------------------------------------------------------
    // Query Execution
    // -------------------------------------------------------------------------
    "/api/query/execute": {
      post: {
        tags: ["Query"],
        summary: "Execute an analytical query asynchronously",
        description: "Enqueues a background query job and returns a jobId immediately.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  connectionId: { type: "string", example: "uuid-v4" },
                  query: { type: "string", example: "SELECT * FROM orders LIMIT 100" },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Job enqueued",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean", example: true },
                    jobId: { type: "string", example: "uuid-v4" },
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
        tags: ["Query"],
        summary: "Check query job status",
        parameters: [
          { name: "jobId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          200: {
            description: "Job status",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean", example: true },
                    status: { type: "string", enum: ["pending", "processing", "completed", "failed"] },
                    rowCount: { type: "integer", example: 1520 },
                    columns: { type: "array", items: { type: "string" } },
                    durationMs: { type: "integer", example: 450 },
                    error: { type: "string", nullable: true },
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
        tags: ["Query"],
        summary: "Get paginated query results",
        parameters: [
          { name: "jobId", in: "path", required: true, schema: { type: "string" } },
          { name: "page", in: "query", required: false, schema: { type: "integer", default: 1 } },
        ],
        responses: {
          200: {
            description: "Paginated result rows",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean", example: true },
                    rows: { type: "array", items: { type: "object" } },
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

    // -------------------------------------------------------------------------
    // Templates
    // -------------------------------------------------------------------------
    "/api/templates": {
      get: {
        tags: ["Templates"],
        summary: "List user templates",
        description: "Returns all custom prompt templates for the authenticated user.",
        responses: {
          200: {
            description: "Array of templates",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      text: { type: "string", example: "Show monthly revenue trends" },
                      createdAt: { type: "string" },
                      updatedAt: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        tags: ["Templates"],
        summary: "Create a template",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["text"],
                properties: {
                  text: { type: "string", example: "Show monthly revenue trends" },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Created",
            content: {
              "application/json": {
                schema: { type: "object", properties: { success: { type: "boolean" }, id: { type: "string" } } },
              },
            },
          },
        },
      },
    },
    "/api/templates/{id}": {
      put: {
        tags: ["Templates"],
        summary: "Update a template",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["text"],
                properties: { text: { type: "string" } },
              },
            },
          },
        },
        responses: {
          200: { description: "Updated" },
          404: { description: "Not found" },
        },
      },
      delete: {
        tags: ["Templates"],
        summary: "Delete a template",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: { description: "Deleted" },
          404: { description: "Not found" },
        },
      },
    },

    // -------------------------------------------------------------------------
    // File Upload
    // -------------------------------------------------------------------------
    "/api/upload/data": {
      post: {
        tags: ["Upload"],
        summary: "Upload a CSV or JSON file",
        description: "Parses an uploaded CSV or JSON file and returns columns, row count, and sample rows for AI analysis.",
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                properties: {
                  file: { type: "string", format: "binary", description: ".csv or .json file (max 10MB)" },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Upload parsed successfully",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean", example: true },
                    uploadId: { type: "string" },
                    fileName: { type: "string" },
                    columns: { type: "array", items: { type: "string" } },
                    rowCount: { type: "integer" },
                    sampleRows: { type: "array", items: { type: "object" } },
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
