import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { createTestPool, resetDatabase } from "../helpers/database.js";

// These tests check that the database itself refuses invalid states, so a bug
// in application code cannot persist them.

let pool: pg.Pool;
let orderId: string;
let paymentId: string;
let secondPaymentId: string;

beforeAll(() => {
  pool = createTestPool();
});

beforeEach(async () => {
  await resetDatabase(pool);
  const order = await pool.query<{ id: string }>(
    `INSERT INTO orders (order_ref, customer_name, amount_minor, currency, created_at)
     VALUES ('ORD-1', 'Ana Duarte', 150000, 'PYG', '2026-10-12T10:00:00Z') RETURNING id`,
  );
  const payments = await pool.query<{ id: string }>(
    `INSERT INTO payments (provider_payment_id, amount_minor, currency, settled_at)
     VALUES ('pay_1', 150000, 'PYG', '2026-10-12T11:00:00Z'),
            ('pay_2', 150000, 'PYG', '2026-10-12T11:05:00Z')
     RETURNING id`,
  );
  orderId = rowAt(order.rows, 0).id;
  paymentId = rowAt(payments.rows, 0).id;
  secondPaymentId = rowAt(payments.rows, 1).id;
});

afterAll(async () => {
  await pool.end();
});

function rowAt<T>(rows: T[], index: number): T {
  const row = rows[index];
  if (row === undefined) throw new Error(`Expected a row at index ${String(index)}`);
  return row;
}

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";

async function expectRejected(sql: string, params: unknown[], sqlState: string): Promise<void> {
  await expect(pool.query(sql, params)).rejects.toMatchObject({ code: sqlState });
}

describe("orders", () => {
  const insertOrder = `INSERT INTO orders (order_ref, customer_name, amount_minor, currency, created_at)
                       VALUES ($1, 'x', $2, $3, now())`;

  it("rejects zero and negative amounts", async () => {
    await expectRejected(insertOrder, ["A", 0, "USD"], CHECK_VIOLATION);
    await expectRejected(insertOrder, ["B", -100, "USD"], CHECK_VIOLATION);
  });

  it("rejects malformed currency codes", async () => {
    await expectRejected(insertOrder, ["C", 100, "usd"], CHECK_VIOLATION);
  });

  it("rejects a repeated order_ref", async () => {
    await expectRejected(insertOrder, ["ORD-1", 100, "USD"], UNIQUE_VIOLATION);
  });

  it("stores PYG and USD amounts as exact integers", async () => {
    await pool.query(insertOrder, ["USD-1", 1234, "USD"]);
    const { rows } = await pool.query<{ order_ref: string; amount_minor: string }>(
      "SELECT order_ref, amount_minor FROM orders ORDER BY order_ref",
    );
    expect(rows).toEqual([
      { order_ref: "ORD-1", amount_minor: "150000" },
      { order_ref: "USD-1", amount_minor: "1234" },
    ]);
  });
});

describe("payments", () => {
  it("allows an unsettled payment created by an early refund", async () => {
    await pool.query(
      "INSERT INTO payments (provider_payment_id, refunded_minor) VALUES ('pay_early', 500)",
    );
    const { rows } = await pool.query(
      "SELECT amount_minor, settled_at FROM payments WHERE provider_payment_id = 'pay_early'",
    );
    expect(rows).toEqual([{ amount_minor: null, settled_at: null }]);
  });

  it("rejects a partially filled settlement", async () => {
    await expectRejected(
      "INSERT INTO payments (provider_payment_id, amount_minor) VALUES ('pay_x', 100)",
      [],
      CHECK_VIOLATION,
    );
  });

  it("defaults anomalies to empty and accepts known codes", async () => {
    await pool.query(
      `INSERT INTO payments (provider_payment_id, refunded_minor, anomalies)
       VALUES ('pay_z', 900, '{refunds_exceed_amount,conflicting_refund}')`,
    );
    const { rows } = await pool.query<{ provider_payment_id: string; anomalies: string[] }>(
      "SELECT provider_payment_id, anomalies FROM payments ORDER BY id",
    );
    expect(rows).toEqual([
      { provider_payment_id: "pay_1", anomalies: [] },
      { provider_payment_id: "pay_2", anomalies: [] },
      { provider_payment_id: "pay_z", anomalies: ["refunds_exceed_amount", "conflicting_refund"] },
    ]);
  });

  it("rejects unknown anomaly codes", async () => {
    await expectRejected(
      "INSERT INTO payments (provider_payment_id, anomalies) VALUES ('pay_w', '{made_up_code}')",
      [],
      CHECK_VIOLATION,
    );
  });

  it("rejects a negative refunded total", async () => {
    await expectRejected(
      "INSERT INTO payments (provider_payment_id, refunded_minor) VALUES ('pay_y', -1)",
      [],
      CHECK_VIOLATION,
    );
  });
});

describe("webhook_events", () => {
  const insertEvent = `INSERT INTO webhook_events
      (provider_event_id, event_type, provider_payment_id, occurred_at, raw_body, body_sha256, payload)
      VALUES ($1, $2, 'pay_1', now(), '{}', repeat('a', 64), '{}')`;

  it("rejects a second event with the same provider event id", async () => {
    await pool.query(insertEvent, ["evt_1", "payment.settled"]);
    await expectRejected(insertEvent, ["evt_1", "payment.settled"], UNIQUE_VIOLATION);
  });

  it("rejects event types outside the contract", async () => {
    await expectRejected(insertEvent, ["evt_2", "payment.created"], CHECK_VIOLATION);
  });
});

describe("reconciliation_results", () => {
  const insertResult = `INSERT INTO reconciliation_results
      (payment_id, status, order_id, stage, confidence, candidate_order_ids, reconciled_at)
      VALUES ($1, $2, $3, $4, $5, $6, now())`;

  it("rejects a matched result without an order", async () => {
    await expectRejected(
      insertResult,
      [paymentId, "matched", null, "fuzzy", 0.95, []],
      CHECK_VIOLATION,
    );
  });

  it("rejects an ambiguous result that picks an order", async () => {
    await expectRejected(
      insertResult,
      [paymentId, "ambiguous", orderId, "fuzzy", null, [orderId, orderId]],
      CHECK_VIOLATION,
    );
  });

  it("rejects an ambiguous result with fewer than two candidates", async () => {
    await expectRejected(
      insertResult,
      [paymentId, "ambiguous", null, "fuzzy", null, [orderId]],
      CHECK_VIOLATION,
    );
  });

  it("rejects a confidence above 1", async () => {
    await expectRejected(
      insertResult,
      [paymentId, "matched", orderId, "fuzzy", 1.5, []],
      CHECK_VIOLATION,
    );
  });

  it("allows only one matched payment per order; the next one is a duplicate", async () => {
    await pool.query(insertResult, [paymentId, "matched", orderId, "exact_reference", 1, []]);
    await expectRejected(
      insertResult,
      [secondPaymentId, "matched", orderId, "exact_reference", 1, []],
      UNIQUE_VIOLATION,
    );
    await pool.query(insertResult, [
      secondPaymentId,
      "duplicate",
      orderId,
      "exact_reference",
      1,
      [],
    ]);

    const { rows } = await pool.query<{ status: string }>(
      "SELECT status FROM reconciliation_results ORDER BY payment_id",
    );
    expect(rows.map((row) => row.status)).toEqual(["matched", "duplicate"]);
  });
});
