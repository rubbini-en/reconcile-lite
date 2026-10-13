import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { buildApp } from "../../../src/app.js";
import { runReconciliation } from "../../../src/reconcile/run.js";
import { createTestPool, resetDatabase } from "../../helpers/database.js";
import { TEST_CONFIG, TEST_REPORT_TOKEN } from "../../helpers/fakepay.js";

let pool: pg.Pool;

beforeAll(() => {
  pool = createTestPool();
});

beforeEach(async () => {
  await resetDatabase(pool);
  await pool.query(
    `INSERT INTO payments
       (provider_payment_id, amount_minor, currency, customer_name, settled_at, updated_at)
     VALUES ('pay_tenth', 1234, 'USD', 'Ana Duarte', '2026-10-10T14:00:00Z', '2026-10-12T00:00:00Z'),
            ('pay_eleventh', 888, 'PYG', NULL, '2026-10-11T14:00:00Z', '2026-10-12T00:00:00Z')`,
  );
  await runReconciliation({ pool, now: () => new Date("2026-10-13T09:00:00Z") });
});

afterAll(async () => {
  await pool.end();
});

async function getExceptions(query = "") {
  const app = buildApp({ pool, config: TEST_CONFIG, logger: false });
  try {
    return await app.inject({
      method: "GET",
      url: `/exceptions${query}`,
      headers: { authorization: `Bearer ${TEST_REPORT_TOKEN}` },
    });
  } finally {
    await app.close();
  }
}

describe("GET /exceptions", () => {
  it("returns the report as JSON and forbids caching it", async () => {
    const response = await getExceptions();
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json<Record<string, unknown>>();
    expect(body).toMatchObject({ day: null, lastReconciledAt: "2026-10-13T09:00:00.000Z" });
    expect(body.items).toEqual([
      expect.objectContaining({ providerPaymentId: "pay_eleventh", status: "unmatched" }),
      {
        providerPaymentId: "pay_tenth",
        status: "unmatched",
        amountMinor: 1234,
        currency: "USD",
        refundedMinor: "0",
        settledAt: "2026-10-10T14:00:00.000Z",
        reference: null,
        customerName: "Ana Duarte",
        orderRef: null,
        stage: null,
        confidence: null,
        candidateOrderRefs: [],
        partialRefund: false,
        anomalies: [],
        resultOutdated: false,
      },
    ]);
  });

  it("filters by UTC day", async () => {
    const response = await getExceptions("?day=2026-10-11");
    expect(response.statusCode).toBe(200);
    const body = response.json<{ day: string; items: { providerPaymentId: string }[] }>();
    expect(body.day).toBe("2026-10-11");
    expect(body.items.map((item) => item.providerPaymentId)).toEqual(["pay_eleventh"]);
  });
});
