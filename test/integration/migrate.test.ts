import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { migrate } from "../../src/db/migrate.js";
import { MIGRATIONS_DIR, createTestPool, resetDatabase } from "../helpers/database.js";

let pool: pg.Pool;

beforeAll(async () => {
  pool = createTestPool();
  await resetDatabase(pool);
});

afterAll(async () => {
  await pool.end();
});

describe("migrate", () => {
  it("creates every table and records the applied migration", async () => {
    const { rows: tables } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`,
    );
    expect(tables.map((row) => row.table_name)).toEqual([
      "orders",
      "payments",
      "reconciliation_results",
      "schema_migrations",
      "webhook_events",
    ]);

    const { rows: applied } = await pool.query<{ name: string }>(
      "SELECT name FROM schema_migrations ORDER BY name",
    );
    expect(applied.map((row) => row.name)).toEqual(["001_init.sql", "002_payment_anomalies.sql"]);
  });

  it("applies nothing when the schema is already up to date", async () => {
    await expect(migrate(pool, MIGRATIONS_DIR)).resolves.toEqual([]);
  });

  it("serializes concurrent runs instead of applying a migration twice", async () => {
    await resetDatabase(pool);
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");

    const results = await Promise.all([
      migrate(pool, MIGRATIONS_DIR),
      migrate(pool, MIGRATIONS_DIR),
    ]);
    expect(results.flat()).toEqual(["001_init.sql", "002_payment_anomalies.sql"]);
  });
});
