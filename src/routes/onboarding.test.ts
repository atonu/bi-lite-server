import assert from "assert";
import { normalizeEngine, normalizeDatabaseConnection, EngineType } from "./onboarding";

function runTests() {
  console.log("Running onboarding logic self-check...");

  // Test normalizeEngine
  assert.strictEqual(normalizeEngine(0), EngineType.MONGODB);
  assert.strictEqual(normalizeEngine("1"), EngineType.POSTGRESQL);
  assert.strictEqual(normalizeEngine("mysql"), EngineType.MYSQL);
  assert.strictEqual(normalizeEngine("invalid"), null);

  // Test normalizeDatabaseConnection - MongoDB
  const mongoConfig = {
    name: "Test Mongo",
    engine: 0,
    connectionString: "mongodb://localhost:27017/test-db",
    tables: ["users"]
  };
  const normalizedMongo = normalizeDatabaseConnection(mongoConfig);
  assert.strictEqual(normalizedMongo.alias, "Test Mongo");
  assert.strictEqual(normalizedMongo.engine, EngineType.MONGODB);
  assert.strictEqual(normalizedMongo.connectionUri, "mongodb://localhost:27017/test-db");

  // Test normalizeDatabaseConnection - SQL
  const postgresConfig = {
    name: "Test PG",
    engine: 1,
    host: "localhost",
    dbUser: "postgres",
    password: "password123",
    dbName: "postgres_db",
  };
  const normalizedPG = normalizeDatabaseConnection(postgresConfig);
  assert.strictEqual(normalizedPG.engine, EngineType.POSTGRESQL);
  assert.strictEqual(normalizedPG.host, "localhost");
  assert.strictEqual(normalizedPG.dbUser, "postgres");
  assert.strictEqual(normalizedPG.password, "password123");

  // Test normalizeDatabaseConnection - missing required fields
  assert.throws(() => {
    normalizeDatabaseConnection({
      name: "Bad PG",
      engine: 1,
      host: "localhost"
    });
  }, /Missing required fields/);

  console.log("Self-check passed successfully!");
}

if (require.main === module) {
  runTests();
}
