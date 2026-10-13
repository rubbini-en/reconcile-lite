import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { buildApp } from "../../../src/app.js";
import { parseOrdersCsv } from "../../../src/orders/csv-import.js";
import { importOrders } from "../../../src/orders/repository.js";
import { runReconciliation } from "../../../src/reconcile/run.js";
import { deliverEvents } from "../../../src/simulator/deliver.js";
import { buildScenario, ordersCsv } from "../../../src/simulator/scenario.js";
import { createTestPool, resetDatabase } from "../../helpers/database.js";
import { TEST_CONFIG, TEST_SECRET } from "../../helpers/fakepay.js";

let pool: pg.Pool;
let app: FastifyInstance;
let webhookUrl: string;

beforeAll(async () => {
  pool = createTestPool();
  app = buildApp({ pool, config: TEST_CONFIG, logger: false });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  webhookUrl = `${address}/webhooks/fakepay`;
});

beforeEach(async () => {
  await resetDatabase(pool);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

const scenario = buildScenario();
const REDELIVERIES = 4;

/** Imports the orders CSV, delivers every event over HTTP, then reconciles. */
async function simulate(seed: number) {
  await importOrders(pool, parseOrdersCsv(ordersCsv(scenario.orders)));
  const sentEventIds: string[] = [];
  const delivery = await deliverEvents(scenario.events, {
    url: webhookUrl,
    secret: TEST_SECRET,
    seed,
    redeliveries: REDELIVERIES,
    fetch: (url, init) => {
      sentEventIds.push((JSON.parse(init.body as string) as { id: string }).id);
      return fetch(url, init);
    },
  });
  await runReconciliation({ pool });
  return { delivery, sentEventIds };
}

/** True when some refund was sent before the settlement of its payment. */
function refundArrivedFirst(sentEventIds: readonly string[]): boolean {
  const firstSent = (id: string) => sentEventIds.indexOf(id);
  return scenario.events.some(
    (refund) =>
      refund.type === "payment.refunded" &&
      scenario.events.some(
        (settlement) =>
          settlement.type === "payment.settled" &&
          settlement.data.payment_id === refund.data.payment_id &&
          firstSent(refund.id) < firstSent(settlement.id),
      ),
  );
}

async function outcomes() {
  const { rows } = await pool.query<{
    payment: string;
    status: string;
    order_ref: string | null;
    stage: string | null;
    partial_refund: boolean;
  }>(
    `SELECT p.provider_payment_id AS payment,
            CASE WHEN p.settled_at IS NULL THEN 'awaiting_settlement' ELSE r.status::text END AS status,
            o.order_ref, r.stage::text AS stage,
            COALESCE(p.refunded_minor > 0 AND p.refunded_minor < p.amount_minor, false) AS partial_refund
     FROM payments p
     LEFT JOIN reconciliation_results r ON r.payment_id = p.id
     LEFT JOIN orders o ON o.id = r.order_id`,
  );
  return Object.fromEntries(
    rows.map((row) => [
      row.payment,
      {
        status: row.status,
        orderRef: row.order_ref,
        stage: row.stage,
        partialRefund: row.partial_refund,
      },
    ]),
  );
}

/** Everything stored, minus timestamps that depend on when the test ran. */
async function storedState() {
  const payments = await pool.query(
    `SELECT provider_payment_id, amount_minor::text, currency, reference, customer_name,
            settled_at, refunded_minor::text, anomalies
     FROM payments ORDER BY provider_payment_id`,
  );
  const results = await pool.query(
    `SELECT p.provider_payment_id, r.status::text, r.order_id::text, r.stage::text,
            r.confidence::text, r.candidate_order_ids::text
     FROM reconciliation_results r JOIN payments p ON p.id = r.payment_id
     ORDER BY p.provider_payment_id`,
  );
  return { payments: payments.rows, results: results.rows };
}

describe("simulator end to end", () => {
  it("drives every reconciliation outcome through the real HTTP endpoint", async () => {
    const { delivery, sentEventIds } = await simulate(2);
    // The scenario is only meaningful if the provider's lack of ordering shows.
    expect(refundArrivedFirst(sentEventIds)).toBe(true);
    expect(delivery).toEqual({
      deliveries: scenario.events.length + REDELIVERIES,
      attempts: scenario.events.length + REDELIVERIES,
      byStatus: { processed: scenario.events.length, duplicate: REDELIVERIES },
      failedEventIds: [],
    });
    expect(await outcomes()).toEqual(scenario.expected);
  });

  it("ends in the same stored state whatever the delivery order", async () => {
    await simulate(1);
    const first = await storedState();
    await resetDatabase(pool);
    await simulate(2);
    expect(await storedState()).toEqual(first);
  });
});
