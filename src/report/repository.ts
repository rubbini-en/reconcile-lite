import type pg from "pg";
import type { MatchStage, PaymentAnomaly, ReconciliationStatus } from "../domain/types.js";
import { minorUnitsFromDb, parseCurrency } from "../money.js";
import {
  isException,
  type ExceptionItem,
  type ExceptionReport,
  type ExceptionStatus,
  type ReportDay,
} from "./exceptions.js";

interface PaymentReportRow {
  provider_payment_id: string;
  amount_minor: string | null;
  currency: string | null;
  refunded_minor: string;
  settled_at: Date | null;
  reference: string | null;
  customer_name: string | null;
  anomalies: PaymentAnomaly[];
  status: ReconciliationStatus | null;
  stage: MatchStage | null;
  confidence: string | null;
  order_ref: string | null;
  candidate_order_refs: string[];
  result_outdated: boolean;
}

// A payment's day is its settlement time or, before settlement, the time of
// its first event. Candidates are listed in their stored (numeric ID) order.
const PAYMENTS_QUERY = `
  WITH dated_payments AS (
    SELECT p.*,
           COALESCE(
             p.settled_at,
             (SELECT min(e.occurred_at) FROM webhook_events e
              WHERE e.provider_payment_id = p.provider_payment_id)
           ) AS activity_at
    FROM payments p
  )
  SELECT p.provider_payment_id, p.amount_minor::text, p.currency, p.refunded_minor::text,
         p.settled_at, p.reference, p.customer_name, p.anomalies,
         r.status::text, r.stage::text, r.confidence::text, o.order_ref,
         ARRAY(
           SELECT c.order_ref
           FROM unnest(r.candidate_order_ids) WITH ORDINALITY AS candidate(id, position)
           JOIN orders c ON c.id = candidate.id
           ORDER BY candidate.position
         ) AS candidate_order_refs,
         (r.payment_id IS NOT NULL
          AND p.updated_at IS DISTINCT FROM r.payment_updated_at) AS result_outdated
  FROM dated_payments p
  LEFT JOIN reconciliation_results r ON r.payment_id = p.id
  LEFT JOIN orders o ON o.id = r.order_id
  WHERE $1::timestamptz IS NULL OR (p.activity_at >= $1 AND p.activity_at < $2)
  ORDER BY p.provider_payment_id COLLATE "C"`;

function exceptionStatus(row: PaymentReportRow): ExceptionStatus {
  if (row.settled_at === null) return "awaiting_settlement";
  return row.status ?? "not_reconciled";
}

function toItem(row: PaymentReportRow): ExceptionItem {
  const amountMinor = row.amount_minor === null ? null : minorUnitsFromDb(row.amount_minor);
  const refunded = BigInt(row.refunded_minor);
  return {
    providerPaymentId: row.provider_payment_id,
    status: exceptionStatus(row),
    amountMinor,
    currency: row.currency === null ? null : parseCurrency(row.currency),
    refundedMinor: row.refunded_minor,
    settledAt: row.settled_at,
    reference: row.reference,
    customerName: row.customer_name,
    orderRef: row.order_ref,
    stage: row.stage,
    confidence: row.confidence,
    candidateOrderRefs: row.candidate_order_refs,
    partialRefund: amountMinor !== null && refunded > 0n && refunded < BigInt(amountMinor),
    anomalies: row.anomalies,
    resultOutdated: row.result_outdated,
  };
}

export interface ReportOptions {
  pool: pg.Pool;
  day?: ReportDay;
  now?: () => Date;
}

/** Reads one consistent snapshot of payments and results. */
export async function loadExceptionReport({
  pool,
  day,
  now = () => new Date(),
}: ReportOptions): Promise<ExceptionReport> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const payments = await client.query<PaymentReportRow>(PAYMENTS_QUERY, [
      day?.start ?? null,
      day?.end ?? null,
    ]);
    const lastRun = await client.query<{ last_reconciled_at: Date | null }>(
      "SELECT max(reconciled_at) AS last_reconciled_at FROM reconciliation_results",
    );
    await client.query("COMMIT");
    const report = {
      generatedAt: now(),
      day: day?.day ?? null,
      lastReconciledAt: lastRun.rows[0]?.last_reconciled_at ?? null,
      items: payments.rows.map(toItem).filter(isException),
    };
    client.release();
    return report;
  } catch (error) {
    // Closing the connection ends the transaction; never reuse it mid-transaction.
    client.release(true);
    throw error;
  }
}
