import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";

const MIGRATION_FILE = /^\d{3}_[a-z0-9_]+\.sql$/;
// Arbitrary constant so concurrent migrate runs wait for each other.
const MIGRATION_LOCK_KEY = 726_001;

/**
 * Applies pending SQL migrations in filename order, all in one transaction.
 * Returns the names applied in this run (empty when already up to date).
 */
export async function migrate(pool: pg.Pool, migrationsDir: string): Promise<string[]> {
  const files = (await readdir(migrationsDir)).filter((name) => MIGRATION_FILE.test(name)).sort();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT        PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
    const alreadyApplied = new Set(rows.map((row) => row.name));

    const applied: string[] = [];
    for (const file of files) {
      if (alreadyApplied.has(file)) continue;
      const sql = await readFile(path.join(migrationsDir, file), "utf8");
      try {
        await client.query(sql);
      } catch (error) {
        throw new Error(`Migration ${file} failed`, { cause: error });
      }
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      applied.push(file);
    }
    await client.query("COMMIT");
    return applied;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
