import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { runReconciliation } from "../../../src/reconcile/run.js";
import { runCli } from "../../helpers/cli.js";
import { createTestPool, resetDatabase } from "../../helpers/database.js";

let pool: pg.Pool;

beforeAll(() => {
  pool = createTestPool();
});

beforeEach(async () => {
  await resetDatabase(pool);
  await pool.query(
    `INSERT INTO payments
       (provider_payment_id, amount_minor, currency, customer_name, settled_at, updated_at)
     VALUES ('pay_unmatched', 777, 'PYG', '=cmd', '2026-10-10T14:00:00Z', '2026-10-12T00:00:00Z'),
            ('pay_other_day', 888, 'PYG', NULL, '2026-10-11T14:00:00Z', '2026-10-12T00:00:00Z')`,
  );
  // updated_at is pinned before the run time, so no result counts as outdated.
  await runReconciliation({ pool, now: () => new Date("2026-10-13T09:00:00Z") });
});

afterAll(async () => {
  await pool.end();
});

const report = (...args: string[]) => runCli("src/report/cli.ts", args);

describe("npm run report", () => {
  it("prints Markdown by default", async () => {
    const result = await report();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("# Exceptions report\n");
    expect(result.stdout).toContain("- Payments needing attention: 2\n");
    expect(result.stdout).toContain("| Unmatched | 2 |");
  });

  it("prints formula-safe CSV for one UTC day", async () => {
    const result = await report("--format", "csv", "--day", "2026-10-10");
    expect(result.code).toBe(0);
    expect(result.stdout.split("\r\n")).toEqual([
      expect.stringMatching(/^provider_payment_id,status,/),
      "pay_unmatched,unmatched,777,PYG,0,2026-10-10T14:00:00.000Z,,'=cmd,,,,,false,,false",
      "",
    ]);
  });

  it.each([
    [["--day", "2026-02-30"], "day must be a calendar date as YYYY-MM-DD"],
    [["--format", "pdf"], "Usage: npm run report"],
    [["--unknown"], "Usage: npm run report"],
  ])("exits 1 for %j", async (args, message) => {
    const result = await report(...args);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.stdout).toBe("");
  });
});
