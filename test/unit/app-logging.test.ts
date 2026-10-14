import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import type pg from "pg";
import { buildApp } from "../../src/app.js";
import { TEST_CONFIG, TEST_REPORT_TOKEN } from "../helpers/fakepay.js";

describe("server error logging", () => {
  it("logs the error's message, code and stack but never a database error's detail", async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    // Shaped like a pg DatabaseError: `detail` repeats row values.
    const failure = Object.assign(new Error('duplicate key value violates unique constraint "x"'), {
      code: "23505",
      detail: "Key (customer_name)=(Fictional Payer) already exists.",
    });
    const pool = { connect: () => Promise.reject(failure) } as unknown as pg.Pool;
    const app = buildApp({ pool, config: TEST_CONFIG, logger: { level: "error", stream } });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/exceptions",
        headers: { authorization: `Bearer ${TEST_REPORT_TOKEN}` },
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ status: "internal_error" });
    } finally {
      await app.close();
    }
    const log = lines.join("");
    expect(log).toContain("Request failed");
    expect(log).toContain("23505");
    expect(log).toContain("app-logging.test.ts");
    expect(log).not.toContain("Fictional Payer");
    expect(log).not.toContain(TEST_REPORT_TOKEN);
  });
});
