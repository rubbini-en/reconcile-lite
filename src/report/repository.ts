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
// When paging, the exception filter runs in SQL (mirroring isException()) so
// that a page holds `limit` exceptions; the complete report relies on
// isException() alone. Paging is keyset-based on the payment ID.
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
  WHERE ($1::timestamptz IS NULL OR (p.activity_at >= $1 AND p.activity_at < $2))
    AND ($3::text IS NULL OR p.provider_payment_id COLLATE "C" > $3)
    AND ($4::int IS NULL OR p.settled_at IS NULL
         OR r.status IS DISTINCT FROM 'matched'
         OR (p.refunded_minor > 0 AND p.refunded_minor < p.amount_minor)
         OR cardinality(p.anomalies) > 0
         OR (r.payment_id IS NOT NULL AND p.updated_at IS DISTINCT FROM r.payment_updated_at))
  ORDER BY p.provider_payment_id COLLATE "C"
  LIMIT $4`;

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

export interface ReportPage {
  limit: number;
  /** Provider payment ID of the last item on the previous page. */
  after?: string | undefined;
}

export interface ReportOptions {
  pool: pg.Pool;
  day?: ReportDay;
  /** Omitted: every exception (the CLI report). */
  page?: ReportPage;
  now?: () => Date;
}

/** Reads one consistent snapshot of payments and results. */
export async function loadExceptionReport({
  pool,
  day,
  page,
  now = () => new Date(),
}: ReportOptions): Promise<ExceptionReport> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const payments = await client.query<PaymentReportRow>(PAYMENTS_QUERY, [
      day?.start ?? null,
      day?.end ?? null,
      page?.after ?? null,
      // One extra row tells whether another page exists.
      page === undefined ? null : page.limit + 1,
    ]);
    const lastRun = await client.query<{ last_reconciled_at: Date | null }>(
      "SELECT max(reconciled_at) AS last_reconciled_at FROM reconciliation_results",
    );
    await client.query("COMMIT");
    const hasMore = page !== undefined && payments.rows.length > page.limit;
    const pageRows = payments.rows.slice(0, page?.limit);
    const items = pageRows.map(toItem).filter(isException);
    const report = {
      generatedAt: now(),
      day: day?.day ?? null,
      lastReconciledAt: lastRun.rows[0]?.last_reconciled_at ?? null,
      items,
      // The last row read, not the last item kept, so no row is read twice.
      nextCursor: hasMore ? (pageRows.at(-1)?.provider_payment_id ?? null) : null,
    };
    client.release();
    return report;
  } catch (error) {
    // Closing the connection ends the transaction; never reuse it mid-transaction.
    client.release(true);
    throw error;
  }
}
