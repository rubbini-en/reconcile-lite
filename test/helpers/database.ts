import path from "node:path";
import type pg from "pg";
import { createPool } from "../../src/db/pool.js";
import { migrate } from "../../src/db/migrate.js";

// Default matches docker-compose.yml's local-only credentials; CI overrides it.
const DEFAULT_TEST_DATABASE_URL =
  "postgres://reconcile:reconcile_local@127.0.0.1:54329/reconcile_test";

export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../migrations");

export function createTestPool(): pg.Pool {
  const url = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  const databaseName = new URL(url).pathname.slice(1);
  // Reset drops every table, so refuse anything that is not a test database.
  if (!databaseName.endsWith("_test")) {
    throw new Error(`Refusing to use database "${databaseName}": name must end with _test`);
  }
  return createPool(url);
}

/** Drops and recreates the public schema, then applies all migrations. */
export async function resetDatabase(pool: pg.Pool): Promise<void> {
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(pool, MIGRATIONS_DIR);
}
