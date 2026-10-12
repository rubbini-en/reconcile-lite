// Shared domain types. These are the contract between the matching engine
// (pure functions) and the code that loads and persists data. Change them only
// through the foundation owner so parallel work does not drift apart.
import type { CurrencyCode } from "../money.js";

/** Database IDs are BIGSERIAL; node-postgres returns them as strings. */
export type OrderId = string;
export type PaymentId = string;

export const RECONCILIATION_STATUSES = [
  "matched",
  "ambiguous",
  "unmatched",
  "amount_mismatch",
  "duplicate",
  "refunded",
] as const;
export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];

export const MATCH_STAGES = ["exact_reference", "amount_time_window", "fuzzy"] as const;
export type MatchStage = (typeof MATCH_STAGES)[number];

/** Mirrors the payments_known_anomalies CHECK in migrations/002_payment_anomalies.sql. */
export const PAYMENT_ANOMALIES = [
  "multiple_settlements",
  "conflicting_refund",
  "refund_currency_mismatch",
  "refunds_exceed_amount",
] as const;
export type PaymentAnomaly = (typeof PAYMENT_ANOMALIES)[number];

export interface Order {
  id: OrderId;
  orderRef: string;
  customerName: string;
  amountMinor: number;
  currency: CurrencyCode;
  createdAt: Date;
}

/** A payment with a received payment.settled event. Only these are reconciled. */
export interface SettledPayment {
  id: PaymentId;
  providerPaymentId: string;
  amountMinor: number;
  currency: CurrencyCode;
  reference: string | null;
  customerName: string | null;
  settledAt: Date;
  /** Sum of distinct refunds received so far; 0 when none. */
  refundedMinor: number;
}

/**
 * Similarity score in [0, 1] rounded to 3 decimals, set only by the fuzzy stage.
 * Deterministic stages (exact reference, amount + time window) use null: they
 * apply a rule, they do not measure similarity.
 */
export type Confidence = number | null;

/** Outcome of reconciling one payment. Each variant maps to one table row shape. */
export type MatchDecision =
  | { status: "matched"; orderId: OrderId; stage: MatchStage; confidence: Confidence }
  | { status: "amount_mismatch"; orderId: OrderId; stage: MatchStage; confidence: Confidence }
  | { status: "duplicate"; orderId: OrderId; stage: MatchStage; confidence: Confidence }
  /** Never auto-resolved: carries every candidate, sorted by ID, and no chosen order. */
  | { status: "ambiguous"; stage: MatchStage; candidateOrderIds: readonly OrderId[] }
  | { status: "unmatched" }
  /** Fully refunded. Keeps the order it would have matched, when there was one. */
  | {
      status: "refunded";
      orderId: OrderId | null;
      stage: MatchStage | null;
      confidence: Confidence;
    };

export interface MatchingConfig {
  /** Stage b: max distance (inclusive) between order.createdAt and payment.settledAt. */
  timeWindowHours: number;
  /** Stage c: only orders created within this distance of settlement are considered. */
  fuzzyWindowHours: number;
  /** Stage c: minimum similarity (0..1) for a fuzzy candidate. */
  fuzzyThreshold: number;
  /** Stage c: minimum lead of the best candidate over the runner-up. */
  fuzzyMinLead: number;
}

export const DEFAULT_MATCHING_CONFIG: Readonly<MatchingConfig> = Object.freeze({
  timeWindowHours: 72,
  fuzzyWindowHours: 720,
  fuzzyThreshold: 0.9,
  fuzzyMinLead: 0.05,
});

export interface MatchInput {
  payment: SettledPayment;
  /** Orders the engine may consider. The caller does not pre-filter them. */
  orders: readonly Order[];
  /** Orders already matched by an earlier payment in this run. */
  claimedOrderIds: ReadonlySet<OrderId>;
  config: Readonly<MatchingConfig>;
}

export type ReconcilePayment = (input: MatchInput) => MatchDecision;
