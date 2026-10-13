import { describe, expect, it } from "vitest";
import { DEFAULT_MATCHING_CONFIG } from "../../../src/domain/types.js";
import type { MatchInput, Order, SettledPayment } from "../../../src/domain/types.js";
import { reconcilePayment } from "../../../src/matching/engine.js";

const SETTLED_AT = new Date("2026-10-10T14:00:00Z");

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: "1",
    orderRef: "ORD-9001",
    customerName: "Elena Valenzuela",
    amountMinor: 150000,
    currency: "PYG",
    createdAt: new Date("2026-10-10T12:00:00Z"),
    ...overrides,
  };
}

function makePayment(overrides: Partial<SettledPayment> = {}): SettledPayment {
  return {
    id: "101",
    providerPaymentId: "pay_fictional_01",
    amountMinor: 150000,
    currency: "PYG",
    reference: "ORD-9001",
    customerName: "Elena Valenzuela",
    settledAt: SETTLED_AT,
    refundedMinor: 0,
    ...overrides,
  };
}

function reconcile(
  payment: SettledPayment,
  orders: readonly Order[],
  claimed: readonly string[] = [],
) {
  const input: MatchInput = {
    payment,
    orders,
    claimedOrderIds: new Set(claimed),
    config: DEFAULT_MATCHING_CONFIG,
  };
  return reconcilePayment(input);
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
      item,
      ...rest,
    ]),
  );
}

// Same amount and window as the payment, but a reference and name that do not
// resemble it, so only stage b can pick it.
const sameAmountOther = makeOrder({ id: "2", orderRef: "INV-555", customerName: "Rodrigo Acosta" });

describe("reconcilePayment precedence", () => {
  it("decides by exact reference before the amount and time window", () => {
    expect(reconcile(makePayment(), [sameAmountOther, makeOrder({ id: "1" })])).toEqual({
      status: "matched",
      orderId: "1",
      stage: "exact_reference",
      confidence: null,
    });
  });

  it("stops at a reference amount mismatch instead of matching another order by amount", () => {
    const referenced = makeOrder({ id: "1", amountMinor: 140000 });
    expect(reconcile(makePayment(), [referenced, sameAmountOther])).toEqual({
      status: "amount_mismatch",
      orderId: "1",
      stage: "exact_reference",
      confidence: null,
    });
  });

  it("reports a duplicate when the referenced order is already claimed", () => {
    expect(reconcile(makePayment(), [makeOrder({ id: "1" }), sameAmountOther], ["1"])).toEqual({
      status: "duplicate",
      orderId: "1",
      stage: "exact_reference",
      confidence: null,
    });
  });

  it("hands over to the amount and time window when no reference matches", () => {
    const payment = makePayment({ reference: "UNKNOWN-REF", customerName: null });
    expect(reconcile(payment, [sameAmountOther])).toEqual({
      status: "matched",
      orderId: "2",
      stage: "amount_time_window",
      confidence: null,
    });
  });

  it("stops at an ambiguous amount and time window instead of trying fuzzy", () => {
    const payment = makePayment({ reference: null });
    // Order 3 would win the fuzzy stage on name, but stage b already decided.
    const orders = [
      sameAmountOther,
      makeOrder({ id: "3", orderRef: "INV-777", customerName: "Elena Valenzuela" }),
    ];
    expect(reconcile(payment, orders)).toEqual({
      status: "ambiguous",
      stage: "amount_time_window",
      candidateOrderIds: ["2", "3"],
    });
  });

  it("hands over to fuzzy and reports an amount mismatch with its confidence", () => {
    const payment = makePayment({ reference: null, amountMinor: 1200, currency: "USD" });
    const order = makeOrder({ id: "4", amountMinor: 1234, currency: "USD", orderRef: "INV-1" });
    expect(reconcile(payment, [order])).toEqual({
      status: "amount_mismatch",
      orderId: "4",
      stage: "fuzzy",
      confidence: 1,
    });
  });

  it("returns unmatched when no stage finds a candidate", () => {
    const payment = makePayment({ reference: null, customerName: "Marcos Gomez" });
    const order = makeOrder({ id: "5", amountMinor: 99000, customerName: "Carlos Benitez" });
    expect(reconcile(payment, [order])).toEqual({ status: "unmatched" });
  });
});

describe("reconcilePayment refunds", () => {
  it("marks a fully refunded payment as refunded and keeps its matched order", () => {
    expect(reconcile(makePayment({ refundedMinor: 150000 }), [makeOrder({ id: "1" })])).toEqual({
      status: "refunded",
      orderId: "1",
      stage: "exact_reference",
      confidence: null,
    });
  });

  it("keeps the fuzzy order and confidence of a fully refunded USD payment", () => {
    const payment = makePayment({
      reference: null,
      amountMinor: 1200,
      currency: "USD",
      refundedMinor: 1200,
    });
    const order = makeOrder({ id: "4", amountMinor: 1234, currency: "USD", orderRef: "INV-1" });
    expect(reconcile(payment, [order])).toEqual({
      status: "refunded",
      orderId: "4",
      stage: "fuzzy",
      confidence: 1,
    });
  });

  it("keeps the order of a fully refunded duplicate", () => {
    expect(
      reconcile(makePayment({ refundedMinor: 150000 }), [makeOrder({ id: "1" })], ["1"]),
    ).toEqual({ status: "refunded", orderId: "1", stage: "exact_reference", confidence: null });
  });

  it("treats refunds above the amount as a full refund", () => {
    expect(reconcile(makePayment({ refundedMinor: 150001 }), [makeOrder({ id: "1" })])).toEqual({
      status: "refunded",
      orderId: "1",
      stage: "exact_reference",
      confidence: null,
    });
  });

  it("uses null fields for a fully refunded payment that matched nothing", () => {
    expect(reconcile(makePayment({ refundedMinor: 150000, reference: null }), [])).toEqual({
      status: "refunded",
      orderId: null,
      stage: null,
      confidence: null,
    });
  });

  it("uses null fields for a fully refunded ambiguous payment", () => {
    const payment = makePayment({ reference: null, refundedMinor: 150000 });
    expect(reconcile(payment, [makeOrder({ id: "1" }), makeOrder({ id: "2" })])).toEqual({
      status: "refunded",
      orderId: null,
      stage: null,
      confidence: null,
    });
  });

  it("ignores a partial refund", () => {
    expect(reconcile(makePayment({ refundedMinor: 149999 }), [makeOrder({ id: "1" })])).toEqual({
      status: "matched",
      orderId: "1",
      stage: "exact_reference",
      confidence: null,
    });
  });
});

describe("reconcilePayment determinism", () => {
  const orders = [
    makeOrder({ id: "10", orderRef: "ORD-9001" }),
    makeOrder({ id: "9", orderRef: "ORD-9010" }),
    makeOrder({ id: "2", orderRef: "ORD-9002" }),
    makeOrder({ id: "30", orderRef: "INV-1", amountMinor: 1, customerName: "Nadie" }),
  ];

  it.each([
    ["exact reference", makePayment()],
    ["ambiguous window", makePayment({ reference: null })],
    // "ord 9001" fails the case-sensitive exact stage and no amount is 2, so
    // fuzzy decides: "ord9001" scores 1.000 and "ord9010" 0.971, within the lead.
    ["ambiguous fuzzy", makePayment({ reference: "ord 9001", amountMinor: 2, customerName: null })],
  ])("gives the same result for every order permutation (%s)", (_label, payment) => {
    const results = permutations(orders).map((permutation) => reconcile(payment, permutation));
    expect(new Set(results.map((result) => JSON.stringify(result))).size).toBe(1);
  });

  it("does not modify its inputs", () => {
    const input: MatchInput = {
      payment: makePayment({ reference: null }),
      orders: Object.freeze([...orders]),
      claimedOrderIds: new Set(["2"]),
      config: DEFAULT_MATCHING_CONFIG,
    };
    const before = JSON.stringify({ ...input, claimedOrderIds: [...input.claimedOrderIds] });
    reconcilePayment(input);
    expect(JSON.stringify({ ...input, claimedOrderIds: [...input.claimedOrderIds] })).toBe(before);
  });
});
