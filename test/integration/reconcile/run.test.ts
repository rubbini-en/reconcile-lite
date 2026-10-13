import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { runReconciliation } from "../../../src/reconcile/run.js";
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

const FIRST_RUN = new Date("2026-10-13T09:00:00Z");
const SECOND_RUN = new Date("2026-10-13T10:00:00Z");

async function insertOrder(ref: string, name: string, amountMinor: number, currency = "PYG") {
  await pool.query(
    `INSERT INTO orders (order_ref, customer_name, amount_minor, currency, created_at)
     VALUES ($1, $2, $3, $4, '2026-10-10T12:00:00Z')`,
    [ref, name, amountMinor, currency],
  );
}

interface PaymentRow {
  id: string;
  amountMinor?: number | null;
  currency?: string | null;
  reference?: string | null;
  customerName?: string | null;
  settledAt?: string | null;
  refundedMinor?: string;
}

async function insertPayment(payment: PaymentRow) {
  await pool.query(
    `INSERT INTO payments
       (provider_payment_id, amount_minor, currency, reference, customer_name, settled_at, refunded_minor)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      payment.id,
      payment.amountMinor === undefined ? 150000 : payment.amountMinor,
      payment.currency === undefined ? "PYG" : payment.currency,
      payment.reference ?? null,
      payment.customerName ?? null,
      payment.settledAt === undefined ? "2026-10-10T14:00:00Z" : payment.settledAt,
      payment.refundedMinor ?? "0",
    ],
  );
}

/** Results with order IDs replaced by refs, candidates in stored order. */
async function storedResults() {
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT p.provider_payment_id AS payment,
            r.status::text AS status,
            o.order_ref AS "order",
            r.stage::text AS stage,
            r.confidence::text AS confidence,
            ARRAY(
              SELECT c.order_ref
              FROM unnest(r.candidate_order_ids) WITH ORDINALITY AS candidate(id, position)
              JOIN orders c ON c.id = candidate.id
              ORDER BY candidate.position
            ) AS candidates,
            r.reconciled_at AS "reconciledAt"
     FROM reconciliation_results r
     JOIN payments p ON p.id = r.payment_id
     LEFT JOIN orders o ON o.id = r.order_id
     ORDER BY p.provider_payment_id`,
  );
  return rows;
}

function row(
  payment: string,
  status: string,
  fields: { order?: string; stage?: string; confidence?: string; candidates?: string[] } = {},
  reconciledAt = FIRST_RUN,
) {
  return {
    payment,
    status,
    order: fields.order ?? null,
    stage: fields.stage ?? null,
    confidence: fields.confidence ?? null,
    candidates: fields.candidates ?? [],
    reconciledAt,
  };
}

async function seedEveryStatus() {
  await insertOrder("ORD-1001", "Ana Duarte", 150000);
  await insertOrder("ORD-2002", "Bruno Ayala", 1234, "USD");
  await insertOrder("ORD-3003", "Carla Rojas", 99000);
  await insertOrder("ORD-4004", "Diego Benitez", 50000);
  await insertOrder("ORD-5005", "Eva Gimenez", 50000);
  await insertOrder("ORD-6006", "Fabio Mora", 20000);
  await insertPayment({ id: "pay_01", reference: "ORD-1001" });
  await insertPayment({ id: "pay_02", reference: "ORD-1001", settledAt: "2026-10-10T15:00:00Z" });
  await insertPayment({ id: "pay_03", amountMinor: 1234, currency: "USD" });
  await insertPayment({ id: "pay_04", amountMinor: 98000, customerName: "Carla Roxas" });
  await insertPayment({ id: "pay_05", amountMinor: 50000 });
  await insertPayment({ id: "pay_06", amountMinor: 777, customerName: "Zulma Zarate" });
  await insertPayment({
    id: "pay_07",
    amountMinor: 20000,
    reference: "ORD-6006",
    refundedMinor: "20000",
  });
  // A refund that arrived before its settlement: not reconcilable yet.
  await insertPayment({
    id: "pay_08",
    amountMinor: null,
    currency: null,
    settledAt: null,
    refundedMinor: "5000",
  });
}

const EVERY_STATUS = [
  row("pay_01", "matched", { order: "ORD-1001", stage: "exact_reference" }),
  row("pay_02", "duplicate", { order: "ORD-1001", stage: "exact_reference" }),
  row("pay_03", "matched", { order: "ORD-2002", stage: "amount_time_window" }),
  row("pay_04", "amount_mismatch", { order: "ORD-3003", stage: "fuzzy", confidence: "0.964" }),
  row("pay_05", "ambiguous", {
    stage: "amount_time_window",
    candidates: ["ORD-4004", "ORD-5005"],
  }),
  row("pay_06", "unmatched"),
  row("pay_07", "refunded", { order: "ORD-6006", stage: "exact_reference" }),
];

describe("runReconciliation", () => {
  it("stores one exact row per settled payment and returns the counts", async () => {
    await seedEveryStatus();
    const summary = await runReconciliation({ pool, now: () => FIRST_RUN });
    expect(await storedResults()).toEqual(EVERY_STATUS);
    expect(summary).toEqual({
      reconciledAt: FIRST_RUN,
      total: 7,
      byStatus: {
        matched: 2,
        ambiguous: 1,
        unmatched: 1,
        amount_mismatch: 1,
        duplicate: 1,
        refunded: 1,
      },
    });
  });

  it("gives the same rows on a rerun, with the new run time", async () => {
    await seedEveryStatus();
    await runReconciliation({ pool, now: () => FIRST_RUN });
    await runReconciliation({ pool, now: () => SECOND_RUN });
    expect(await storedResults()).toEqual(
      EVERY_STATUS.map((expected) => ({ ...expected, reconciledAt: SECOND_RUN })),
    );
  });

  it("moves a claim to an earlier payment that arrived after the last run", async () => {
    await insertOrder("ORD-1001", "Ana Duarte", 150000);
    await insertPayment({ id: "pay_late", reference: "ORD-1001" });
    await runReconciliation({ pool, now: () => FIRST_RUN });
    await insertPayment({
      id: "pay_early",
      reference: "ORD-1001",
      settledAt: "2026-10-10T13:00:00Z",
    });
    await runReconciliation({ pool, now: () => SECOND_RUN });
    expect(await storedResults()).toEqual([
      row("pay_early", "matched", { order: "ORD-1001", stage: "exact_reference" }, SECOND_RUN),
      row("pay_late", "duplicate", { order: "ORD-1001", stage: "exact_reference" }, SECOND_RUN),
    ]);
  });

  it("treats a refunded total above 2^53 - 1 as a full refund", async () => {
    await insertOrder("ORD-1001", "Ana Duarte", 150000);
    await insertPayment({ id: "pay_01", reference: "ORD-1001", refundedMinor: "9007199254740993" });
    await runReconciliation({ pool, now: () => FIRST_RUN });
    expect(await storedResults()).toEqual([
      row("pay_01", "refunded", { order: "ORD-1001", stage: "exact_reference" }),
    ]);
  });

  it("keeps the previous results when a run fails", async () => {
    await seedEveryStatus();
    await runReconciliation({ pool, now: () => FIRST_RUN });
    // The schema allows any three-letter code; the application supports PYG and USD.
    await insertOrder("ORD-9999", "Unsupported Currency", 100, "EUR");
    await expect(runReconciliation({ pool, now: () => SECOND_RUN })).rejects.toThrow(/EUR/);
    expect(await storedResults()).toEqual(EVERY_STATUS);
  });

  it("restores the previous results when an insert fails after the delete", async () => {
    await seedEveryStatus();
    await runReconciliation({ pool, now: () => FIRST_RUN });
    // Test-only trigger on the disposable test schema: fails the run after its
    // DELETE has already removed the old rows inside the transaction.
    await pool.query(`
      CREATE FUNCTION reject_result_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected insert failure'; END $$;
      CREATE TRIGGER reject_result_insert BEFORE INSERT ON reconciliation_results
        FOR EACH ROW EXECUTE FUNCTION reject_result_insert();
    `);
    await expect(runReconciliation({ pool, now: () => SECOND_RUN })).rejects.toThrow(
      /injected insert failure/,
    );
    expect(await storedResults()).toEqual(EVERY_STATUS);
  });

  it("serializes concurrent runs", async () => {
    await seedEveryStatus();
    const runs = await Promise.all(
      [FIRST_RUN, SECOND_RUN, FIRST_RUN].map((runAt) =>
        runReconciliation({ pool, now: () => runAt }),
      ),
    );
    expect(runs.map((summary) => summary.total)).toEqual([7, 7, 7]);
    const stored = await storedResults();
    expect(stored).toHaveLength(7);
    expect(stored.map(({ reconciledAt: _reconciledAt, ...fields }) => fields)).toEqual(
      EVERY_STATUS.map(({ reconciledAt: _reconciledAt, ...fields }) => fields),
    );
  });
});
