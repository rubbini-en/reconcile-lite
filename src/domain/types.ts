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

/** Outcome of reconciling one payment. Each variant maps to one table row shape. */
export type MatchDecision =
  | { status: "matched"; orderId: OrderId; stage: MatchStage; confidence: number }
  | {
      status: "amount_mismatch";
      orderId: OrderId;
      stage: MatchStage;
      confidence: number;
    }
  | { status: "duplicate"; orderId: OrderId; stage: MatchStage; confidence: number }
  /** Never auto-resolved: carries every candidate and no chosen order. */
  | { status: "ambiguous"; stage: MatchStage; candidateOrderIds: readonly OrderId[] }
  | { status: "unmatched" }
  /** Fully refunded. Keeps the order it matched, when it matched one. */
  | {
      status: "refunded";
      orderId: OrderId | null;
      stage: MatchStage | null;
      confidence: number | null;
    };

export interface MatchingConfig {
  /** Stage b: max distance between order.createdAt and payment.settledAt. */
  timeWindowHours: number;
  /** Stage c: minimum similarity (0..1) for a fuzzy candidate. */
  fuzzyThreshold: number;
  /** Stage c: minimum lead of the best candidate over the runner-up. */
  fuzzyMinLead: number;
}

export const DEFAULT_MATCHING_CONFIG: Readonly<MatchingConfig> = Object.freeze({
  timeWindowHours: 72,
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
