import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { RECONCILE_LOCK_KEY } from "../../../src/reconcile/run.js";
import { runCli } from "../../helpers/cli.js";
import { createTestPool, resetDatabase } from "../../helpers/database.js";

let pool: pg.Pool;

beforeAll(() => {
  pool = createTestPool();
});

beforeEach(async () => {
  await resetDatabase(pool);
});

afterAll(async () => {
  await pool.end();
});

describe("npm run reconcile", () => {
  it("prints a summary and exits 0", async () => {
    const result = await runCli("src/reconcile/cli.ts", []);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^Reconciled 0 settled payments at /);
  });

  it("exits 1 with a clear message while another run holds the lock", async () => {
    const holder = await pool.connect();
    try {
      await holder.query("SELECT pg_advisory_lock($1)", [RECONCILE_LOCK_KEY]);
      const result = await runCli("src/reconcile/cli.ts", []);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "A reconcile run is already in progress; try again when it finishes.",
      );
      expect(result.stderr).not.toContain("    at ");
    } finally {
      await holder.query("SELECT pg_advisory_unlock($1)", [RECONCILE_LOCK_KEY]);
      holder.release();
    }
  });
});
