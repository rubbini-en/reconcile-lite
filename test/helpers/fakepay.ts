import { createHmac } from "node:crypto";
import type { CurrencyCode } from "../../src/money.js";

export const TEST_SECRET = "fictional-fakepay-test-secret-123456789";
export const NOW_SECONDS = 1_791_811_800;

interface EventOptions {
  id?: string;
  paymentId?: string;
  amount?: number;
  currency?: CurrencyCode;
  occurredAt?: string;
}

export function settled(options: EventOptions = {}) {
  return {
    id: options.id ?? "evt_settled",
    type: "payment.settled" as const,
    occurred_at: options.occurredAt ?? "2026-10-12T14:00:00Z",
    data: {
      payment_id: options.paymentId ?? "pay_fictional",
      amount_minor: options.amount ?? 150000,
      currency: options.currency ?? "PYG",
      reference: "ORD-FICTIONAL" as string | null,
      customer_name: "Fictional Payer" as string | null,
    },
  };
}

export function refunded(options: EventOptions & { refundId?: string } = {}) {
  return {
    id: options.id ?? "evt_refund",
    type: "payment.refunded" as const,
    occurred_at: options.occurredAt ?? "2026-10-13T14:00:00Z",
    data: {
      payment_id: options.paymentId ?? "pay_fictional",
      refund_id: options.refundId ?? "rf_fictional",
      amount_minor: options.amount ?? 50000,
      currency: options.currency ?? "PYG",
    },
  };
}

export function sign(rawBody: Buffer, timestamp = NOW_SECONDS, secret = TEST_SECRET): string {
  const digest = createHmac("sha256", secret)
    .update(`${String(timestamp)}.`)
    .update(rawBody)
    .digest("hex");
  return `t=${String(timestamp)},v1=${digest}`;
}
