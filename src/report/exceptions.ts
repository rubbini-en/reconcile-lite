// The exceptions report: every payment that needs a person to look at it.
import type { MatchStage, PaymentAnomaly, ReconciliationStatus } from "../domain/types.js";
import type { CurrencyCode } from "../money.js";

export class ReportError extends Error {
  override name = "ReportError";
}

/**
 * The reconciliation status, or why there is none: the payment has no
 * settlement yet, or it settled after the last reconcile run.
 */
export type ExceptionStatus = ReconciliationStatus | "awaiting_settlement" | "not_reconciled";

export interface ExceptionItem {
  providerPaymentId: string;
  status: ExceptionStatus;
  /** Null while the payment awaits settlement. */
  amountMinor: number | null;
  currency: CurrencyCode | null;
  /** Exact decimal text: the stored total may exceed 2^53 − 1 (see anomalies). */
  refundedMinor: string;
  settledAt: Date | null;
  reference: string | null;
  customerName: string | null;
  orderRef: string | null;
  stage: MatchStage | null;
  /** Exact NUMERIC(4,3) text, e.g. "0.964"; null outside the fuzzy stage. */
  confidence: string | null;
  candidateOrderRefs: string[];
  /** Refunded, but less than the settled amount. The status does not change. */
  partialRefund: boolean;
  anomalies: PaymentAnomaly[];
  /** The payment changed after its result was computed; rerun reconcile. */
  resultOutdated: boolean;
}

export interface ReportDay {
  day: string;
  start: Date;
  end: Date;
}

export interface ExceptionReport {
  generatedAt: Date;
  day: string | null;
  lastReconciledAt: Date | null;
  items: ExceptionItem[];
  /** Cursor for the next page, or null on the last page and in full reports. */
  nextCursor: string | null;
}

export function isException(item: ExceptionItem): boolean {
  return (
    item.status !== "matched" ||
    item.partialRefund ||
    item.anomalies.length > 0 ||
    item.resultOutdated
  );
}

const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

/** A UTC calendar day as the half-open range [start, end). */
export function parseReportDay(text: string): ReportDay {
  const start = new Date(`${text}T00:00:00Z`);
  // Date rolls impossible days over (February 30 becomes March 2); the
  // round trip rejects them.
  if (
    !CALENDAR_DAY.test(text) ||
    Number.isNaN(start.getTime()) ||
    start.toISOString().slice(0, 10) !== text
  ) {
    throw new ReportError("day must be a calendar date as YYYY-MM-DD");
  }
  return { day: text, start, end: new Date(start.getTime() + MS_PER_DAY) };
}
