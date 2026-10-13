import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { ingestWebhook } from "../../../src/webhooks/ingest.js";
import { settled } from "../../helpers/fakepay.js";

function failingDatabase(rollbackFails: boolean) {
  const failure = new Error("fictional database failure");
  const rollbackFailure = new Error("fictional connection lost");
  const statements: string[] = [];
  const query = vi.fn((sql: string) => {
    statements.push(sql);
    if (sql.startsWith("INSERT")) return Promise.reject(failure);
    if (sql === "ROLLBACK" && rollbackFails) return Promise.reject(rollbackFailure);
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
  const release = vi.fn();
  const pool = { connect: vi.fn(() => Promise.resolve({ query, release })) } as unknown as pg.Pool;
  return { pool, statements, release, failure };
}

describe("ingestion transaction cleanup", () => {
  it.each([false, true])(
    "rolls back and preserves original failure (rollback failure: %s)",
    async (rollbackFails) => {
      const { pool, statements, release, failure } = failingDatabase(rollbackFails);
      const event = settled();
      await expect(
        ingestWebhook({ pool, event, rawBody: Buffer.from(JSON.stringify(event)), payload: event }),
      ).rejects.toBe(failure);
      expect(statements.at(-1)).toBe("ROLLBACK");
      expect(statements).not.toContain("COMMIT");
      expect(release).toHaveBeenCalledTimes(1);
      if (rollbackFails) expect(release.mock.calls[0]?.[0]).toBeTruthy();
      else expect(release.mock.calls[0]?.[0]).toBeFalsy();
    },
  );
});
