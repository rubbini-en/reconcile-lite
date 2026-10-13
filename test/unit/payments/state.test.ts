import { describe, expect, it } from "vitest";
import { foldPaymentEvents } from "../../../src/payments/state.js";
import { PAYMENT_ANOMALIES } from "../../../src/domain/types.js";
import { refunded, settled } from "../../helpers/fakepay.js";

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length === 0) return [[]];
  return items.flatMap((item, index) =>
    permutations(items.filter((_, i) => i !== index)).map((rest) => [item, ...rest]),
  );
}

describe("payment replay", () => {
  it.each(["PYG", "USD"] as const)("is arrival independent for %s", (currency) => {
    const events = [
      settled({ currency, amount: 1234 }),
      refunded({ currency, amount: 100 }),
      refunded({ id: "evt_b", refundId: "rf_b", currency, amount: 234 }),
    ];
    for (const order of permutations(events)) {
      expect(foldPaymentEvents(order)).toEqual({
        amountMinor: 1234,
        currency,
        reference: "ORD-FICTIONAL",
        customerName: "Fictional Payer",
        settledAt: "2026-10-12T14:00:00Z",
        refundedMinor: 334n,
        anomalies: [],
      });
    }
  });
  it("keeps settlement fields null before settlement", () => {
    expect(foldPaymentEvents([refunded()])).toEqual({
      amountMinor: null,
      currency: null,
      reference: null,
      customerName: null,
      settledAt: null,
      refundedMinor: 50000n,
      anomalies: [],
    });
  });
  it("reports mixed refund currencies before settlement without changing the total", () => {
    const events = [
      refunded({ amount: 10 }),
      refunded({ id: "evt_usd", refundId: "rf_usd", currency: "USD", amount: 20 }),
    ];
    for (const order of permutations(events)) {
      expect(foldPaymentEvents(order)).toMatchObject({
        currency: null,
        amountMinor: null,
        refundedMinor: 30n,
        anomalies: ["refund_currency_mismatch"],
      });
    }
  });
  it("deduplicates refund IDs", () => {
    expect(foldPaymentEvents([refunded(), refunded({ id: "evt_other" })]).refundedMinor).toBe(
      50000n,
    );
  });
  it("reports all anomaly codes, excludes wrong currency and keeps excess", () => {
    const events = [
      settled({ amount: 100 }),
      settled({ id: "evt_z", amount: 300 }),
      refunded({ amount: 120 }),
      refunded({ id: "evt_zrefund", amount: 140 }),
      refunded({ id: "evt_usd", refundId: "rf_usd", currency: "USD", amount: 10 }),
    ];
    const state = foldPaymentEvents(events);
    expect(state.amountMinor).toBe(100);
    expect(state.refundedMinor).toBe(120n);
    expect(state.anomalies).toEqual([...PAYMENT_ANOMALIES]);
  });
  it("uses provider IDs for equal timestamps regardless of arrival", () => {
    const events = [
      refunded({ id: "evt_b", amount: 5 }),
      refunded({ id: "evt_a", amount: 10, currency: "USD" }),
    ];
    for (const order of permutations(events)) {
      expect(foldPaymentEvents(order).refundedMinor).toBe(10n);
      expect(foldPaymentEvents(order).anomalies).toEqual([
        "conflicting_refund",
        "refund_currency_mismatch",
      ]);
    }
  });
  it("orders by actual time including fractional seconds", () => {
    const events = [
      settled({ id: "evt_a", amount: 2, occurredAt: "2026-10-12T14:00:00.001Z" }),
      settled({ id: "evt_z", amount: 1 }),
    ];
    expect(foldPaymentEvents(events).amountMinor).toBe(1);
  });
  it("preserves submillisecond timestamp ordering", () => {
    expect(
      foldPaymentEvents([
        settled({ id: "evt_a", amount: 2, occurredAt: "2026-10-12T14:00:00.0002Z" }),
        settled({ id: "evt_z", amount: 1, occurredAt: "2026-10-12T14:00:00.0001Z" }),
      ]).amountMinor,
    ).toBe(1);
  });
  it("checks early refunds against a later settlement", () => {
    const events = [refunded({ currency: "USD", occurredAt: "2026-10-10T00:00:00Z" }), settled()];
    expect(foldPaymentEvents(events).refundedMinor).toBe(0n);
    expect(foldPaymentEvents(events).anomalies).toEqual(["refund_currency_mismatch"]);
  });
  it("sums beyond the safe number range exactly", () => {
    const state = foldPaymentEvents([
      settled({ amount: Number.MAX_SAFE_INTEGER }),
      refunded({ amount: Number.MAX_SAFE_INTEGER }),
      refunded({ id: "evt_b", refundId: "rf_b", amount: 2 }),
    ]);
    expect(state.refundedMinor).toBe(9007199254740993n);
    expect(state.anomalies).toEqual(["refunds_exceed_amount"]);
  });
});
