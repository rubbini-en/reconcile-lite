import { PAYMENT_ANOMALIES, type PaymentAnomaly } from "../domain/types.js";
import type { CurrencyCode } from "../money.js";
import type { FakePayEvent } from "../webhooks/schema.js";

export interface PaymentState {
  amountMinor: number | null;
  currency: CurrencyCode | null;
  reference: string | null;
  customerName: string | null;
  settledAt: string | null;
  refundedMinor: bigint;
  anomalies: PaymentAnomaly[];
}

function compareEvents(left: FakePayEvent, right: FakePayEvent): number {
  // Compare whole seconds first, then decimal fractions without losing precision.
  const leftSeconds = Date.parse(left.occurred_at.replace(/\.\d+Z$/, "Z"));
  const rightSeconds = Date.parse(right.occurred_at.replace(/\.\d+Z$/, "Z"));
  if (leftSeconds !== rightSeconds) return leftSeconds < rightSeconds ? -1 : 1;
  const leftFraction = /\.(\d+)Z$/.exec(left.occurred_at)?.[1] ?? "";
  const rightFraction = /\.(\d+)Z$/.exec(right.occurred_at)?.[1] ?? "";
  const width = Math.max(leftFraction.length, rightFraction.length);
  const leftDigits = leftFraction.padEnd(width, "0");
  const rightDigits = rightFraction.padEnd(width, "0");
  if (leftDigits !== rightDigits) return leftDigits < rightDigits ? -1 : 1;
  return left.id === right.id ? 0 : left.id < right.id ? -1 : 1;
}

export function foldPaymentEvents(events: readonly FakePayEvent[]): PaymentState {
  const ordered = [...events].sort(compareEvents);
  const settlements = ordered.filter((event) => event.type === "payment.settled");
  const settlement = settlements[0];
  const anomalies = new Set<PaymentAnomaly>();
  if (settlements.length > 1) anomalies.add("multiple_settlements");
  const refunds = new Map<string, { amount_minor: number; currency: CurrencyCode }>();
  let refundedMinor = 0n;
  for (const event of ordered) {
    if (event.type !== "payment.refunded") continue;
    const refund = event.data;
    const previous = refunds.get(refund.refund_id);
    if (previous !== undefined) {
      if (previous.amount_minor !== refund.amount_minor || previous.currency !== refund.currency) {
        anomalies.add("conflicting_refund");
      }
      continue;
    }
    refunds.set(refund.refund_id, refund);
    if (settlement !== undefined && refund.currency !== settlement.data.currency) {
      anomalies.add("refund_currency_mismatch");
    } else {
      refundedMinor += BigInt(refund.amount_minor);
    }
  }
  // Without a settlement there is no currency to check against, but refunds that
  // disagree with each other are already inconsistent.
  const refundCurrencies = new Set(
    ordered.flatMap((event) => (event.type === "payment.refunded" ? [event.data.currency] : [])),
  );
  if (settlement === undefined && refundCurrencies.size > 1) {
    anomalies.add("refund_currency_mismatch");
  }
  if (settlement !== undefined && refundedMinor > BigInt(settlement.data.amount_minor)) {
    anomalies.add("refunds_exceed_amount");
  }
  return {
    amountMinor: settlement?.data.amount_minor ?? null,
    currency: settlement?.data.currency ?? null,
    reference: settlement?.data.reference ?? null,
    customerName: settlement?.data.customer_name ?? null,
    settledAt: settlement?.occurred_at ?? null,
    refundedMinor,
    anomalies: PAYMENT_ANOMALIES.filter((code) => anomalies.has(code)),
  };
}
