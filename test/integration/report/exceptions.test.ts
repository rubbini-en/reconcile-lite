import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { runReconciliation } from "../../../src/reconcile/run.js";
import { parseReportDay, type ExceptionItem } from "../../../src/report/exceptions.js";
import { loadExceptionReport } from "../../../src/report/repository.js";
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

const RUN_AT = new Date("2026-10-13T09:00:00Z");
const GENERATED_AT = new Date("2026-10-13T12:00:00Z");
// Seeded rows predate the run, so only explicit changes make a result outdated.
const SEEDED_AT = "2026-10-12T00:00:00Z";

async function insertOrder(ref: string, name: string, amountMinor: number) {
  await pool.query(
    `INSERT INTO orders (order_ref, customer_name, amount_minor, currency, created_at)
     VALUES ($1, $2, $3, 'PYG', '2026-10-10T12:00:00Z')`,
    [ref, name, amountMinor],
  );
}

async function insertPayment(
  id: string,
  fields: {
    amountMinor?: number;
    reference?: string;
    customerName?: string;
    settledAt?: string | null;
    refundedMinor?: string;
    anomalies?: string[];
  } = {},
) {
  const settled = fields.settledAt !== null;
  await pool.query(
    `INSERT INTO payments (provider_payment_id, amount_minor, currency, reference, customer_name,
                           settled_at, refunded_minor, anomalies, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      settled ? (fields.amountMinor ?? 150000) : null,
      settled ? "PYG" : null,
      fields.reference ?? null,
      fields.customerName ?? null,
      settled ? (fields.settledAt ?? "2026-10-10T14:00:00Z") : null,
      fields.refundedMinor ?? "0",
      fields.anomalies ?? [],
      SEEDED_AT,
    ],
  );
}

async function seed() {
  await insertOrder("ORD-1001", "Ana Duarte", 150000);
  await insertOrder("ORD-2002", "Bruno Ayala", 80000);
  await insertOrder("ORD-3003", "Carla Rojas", 99000);
  await insertOrder("ORD-4004", "Diego Benitez", 50000);
  await insertOrder("ORD-5005", "Eva Gimenez", 50000);
  await insertOrder("ORD-6006", "Fabio Mora", 20000);
  await insertPayment("pay_clean", { reference: "ORD-1001" });
  await insertPayment("pay_dup", { reference: "ORD-1001", settledAt: "2026-10-10T15:00:00Z" });
  await insertPayment("pay_partial", {
    reference: "ORD-2002",
    amountMinor: 80000,
    refundedMinor: "30000",
  });
  await insertPayment("pay_anomaly", {
    reference: "ORD-3003",
    amountMinor: 99000,
    anomalies: ["multiple_settlements"],
  });
  await insertPayment("pay_ambiguous", { amountMinor: 50000 });
  await insertPayment("pay_unmatched", {
    amountMinor: 777,
    customerName: "Zulma Zarate",
    settledAt: "2026-10-11T09:00:00Z",
  });
  await insertPayment("pay_outdated", { reference: "ORD-6006", amountMinor: 20000 });
  await insertPayment("pay_waiting", { settledAt: null, refundedMinor: "5000" });
  await pool.query(
    `INSERT INTO webhook_events (provider_event_id, event_type, provider_payment_id, occurred_at,
                                 raw_body, body_sha256, payload)
     VALUES ('evt_waiting', 'payment.refunded', 'pay_waiting', '2026-10-10T16:00:00Z',
             '{}', repeat('0', 64), '{}')`,
  );
  await runReconciliation({ pool, now: () => RUN_AT });
  // After the run: a new settlement, and a full refund of a matched payment.
  await insertPayment("pay_late", { amountMinor: 1, settledAt: "2026-10-10T18:00:00Z" });
  await pool.query(
    `UPDATE payments SET refunded_minor = 20000, updated_at = '2026-10-13T10:00:00Z'
     WHERE provider_payment_id = 'pay_outdated'`,
  );
}

function item(providerPaymentId: string, fields: Partial<ExceptionItem>): ExceptionItem {
  return {
    providerPaymentId,
    status: "matched",
    amountMinor: 150000,
    currency: "PYG",
    refundedMinor: "0",
    settledAt: new Date("2026-10-10T14:00:00Z"),
    reference: null,
    customerName: null,
    orderRef: null,
    stage: null,
    confidence: null,
    candidateOrderRefs: [],
    partialRefund: false,
    anomalies: [],
    resultOutdated: false,
    ...fields,
  };
}

const AMBIGUOUS = item("pay_ambiguous", {
  status: "ambiguous",
  amountMinor: 50000,
  stage: "amount_time_window",
  candidateOrderRefs: ["ORD-4004", "ORD-5005"],
});
const ANOMALY = item("pay_anomaly", {
  amountMinor: 99000,
  reference: "ORD-3003",
  orderRef: "ORD-3003",
  stage: "exact_reference",
  anomalies: ["multiple_settlements"],
});
const DUPLICATE = item("pay_dup", {
  status: "duplicate",
  reference: "ORD-1001",
  orderRef: "ORD-1001",
  stage: "exact_reference",
  settledAt: new Date("2026-10-10T15:00:00Z"),
});
const LATE = item("pay_late", {
  status: "not_reconciled",
  amountMinor: 1,
  settledAt: new Date("2026-10-10T18:00:00Z"),
});
const OUTDATED = item("pay_outdated", {
  amountMinor: 20000,
  refundedMinor: "20000",
  reference: "ORD-6006",
  orderRef: "ORD-6006",
  stage: "exact_reference",
  resultOutdated: true,
});
const PARTIAL = item("pay_partial", {
  amountMinor: 80000,
  refundedMinor: "30000",
  reference: "ORD-2002",
  orderRef: "ORD-2002",
  stage: "exact_reference",
  partialRefund: true,
});
const UNMATCHED = item("pay_unmatched", {
  status: "unmatched",
  amountMinor: 777,
  customerName: "Zulma Zarate",
  settledAt: new Date("2026-10-11T09:00:00Z"),
});
const WAITING = item("pay_waiting", {
  status: "awaiting_settlement",
  amountMinor: null,
  currency: null,
  refundedMinor: "5000",
  settledAt: null,
});

describe("loadExceptionReport", () => {
  it("lists every payment that needs attention and leaves out clean matches", async () => {
    await seed();
    expect(await loadExceptionReport({ pool, now: () => GENERATED_AT })).toEqual({
      generatedAt: GENERATED_AT,
      day: null,
      lastReconciledAt: RUN_AT,
      items: [AMBIGUOUS, ANOMALY, DUPLICATE, LATE, OUTDATED, PARTIAL, UNMATCHED, WAITING],
    });
  });

  it("filters by UTC day, using the first event for unsettled payments", async () => {
    await seed();
    const tenth = await loadExceptionReport({
      pool,
      day: parseReportDay("2026-10-10"),
      now: () => GENERATED_AT,
    });
    expect(tenth.day).toBe("2026-10-10");
    expect(tenth.items).toEqual([AMBIGUOUS, ANOMALY, DUPLICATE, LATE, OUTDATED, PARTIAL, WAITING]);
    const eleventh = await loadExceptionReport({ pool, day: parseReportDay("2026-10-11") });
    expect(eleventh.items).toEqual([UNMATCHED]);
  });

  it("returns an empty report before any reconcile run", async () => {
    expect(await loadExceptionReport({ pool, now: () => GENERATED_AT })).toEqual({
      generatedAt: GENERATED_AT,
      day: null,
      lastReconciledAt: null,
      items: [],
    });
  });
});
