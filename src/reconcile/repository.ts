// SQL for the reconcile run: load its inputs, replace its outputs.
import type pg from "pg";
import type { MatchDecision, Order, SettledPayment } from "../domain/types.js";
import { minorUnitsFromDb, parseCurrency } from "../money.js";
import type { PaymentDecision } from "./batch.js";

type Queryable = Pick<pg.PoolClient, "query">;

interface PaymentRow {
  id: string;
  provider_payment_id: string;
  amount_minor: string;
  currency: string;
  reference: string | null;
  customer_name: string | null;
  settled_at: Date;
  refunded_minor: string;
}

interface OrderRow {
  id: string;
  order_ref: string;
  customer_name: string;
  amount_minor: string;
  currency: string;
  created_at: Date;
}

/**
 * Only settled payments are reconciled. Refund totals above 2^53 − 1 are capped
 * there: amounts never exceed it, so the cap is still a full refund, and the
 * exact total stays in the table.
 */
export async function loadSettledPayments(client: Queryable): Promise<SettledPayment[]> {
  const { rows } = await client.query<PaymentRow>(
    `SELECT id::text, provider_payment_id, amount_minor::text, currency, reference,
            customer_name, settled_at, LEAST(refunded_minor, $1::bigint)::text AS refunded_minor
     FROM payments
     WHERE settled_at IS NOT NULL`,
    [Number.MAX_SAFE_INTEGER],
  );
  return rows.map((row) => ({
    id: row.id,
    providerPaymentId: row.provider_payment_id,
    amountMinor: minorUnitsFromDb(row.amount_minor),
    currency: parseCurrency(row.currency),
    reference: row.reference,
    customerName: row.customer_name,
    settledAt: row.settled_at,
    refundedMinor: minorUnitsFromDb(row.refunded_minor),
  }));
}

export async function loadOrders(client: Queryable): Promise<Order[]> {
  const { rows } = await client.query<OrderRow>(
    `SELECT id::text, order_ref, customer_name, amount_minor::text, currency, created_at
     FROM orders`,
  );
  return rows.map((row) => ({
    id: row.id,
    orderRef: row.order_ref,
    customerName: row.customer_name,
    amountMinor: minorUnitsFromDb(row.amount_minor),
    currency: parseCurrency(row.currency),
    createdAt: row.created_at,
  }));
}

function resultColumns(decision: MatchDecision) {
  switch (decision.status) {
    case "matched":
    case "amount_mismatch":
    case "duplicate":
    case "refunded":
      return {
        orderId: decision.orderId,
        stage: decision.stage,
        confidence: decision.confidence,
        candidateOrderIds: [],
      };
    case "ambiguous":
      return {
        orderId: null,
        stage: decision.stage,
        confidence: null,
        candidateOrderIds: decision.candidateOrderIds,
      };
    case "unmatched":
      return { orderId: null, stage: null, confidence: null, candidateOrderIds: [] };
  }
}

/**
 * Results are derived data, so a run replaces all of them. Updating rows one by
 * one could briefly give two payments the same matched order and violate the
 * one-match-per-order index; delete and insert inside one transaction cannot.
 */
export async function replaceResults(
  client: Queryable,
  decisions: readonly PaymentDecision[],
  reconciledAt: Date,
): Promise<void> {
  await client.query("DELETE FROM reconciliation_results");
  for (const { paymentId, decision } of decisions) {
    const columns = resultColumns(decision);
    await client.query(
      // The run is REPEATABLE READ, so this subquery reads the same snapshot as
      // loadSettledPayments: the version reconciled, even if a webhook commits
      // meanwhile (that change then shows as an outdated result).
      `INSERT INTO reconciliation_results
         (payment_id, status, order_id, stage, confidence, candidate_order_ids, reconciled_at,
          payment_updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::bigint[], $7,
               (SELECT updated_at FROM payments WHERE id = $1))`,
      [
        paymentId,
        decision.status,
        columns.orderId,
        columns.stage,
        columns.confidence,
        columns.candidateOrderIds,
        reconciledAt,
      ],
    );
  }
}
