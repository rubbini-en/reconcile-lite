import { describe, expect, it } from "vitest";
import { DEFAULT_MATCHING_CONFIG } from "../../../src/domain/types.js";
import type { Order, SettledPayment } from "../../../src/domain/types.js";
import { reconcileBatch } from "../../../src/reconcile/batch.js";

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
    providerPaymentId: "pay_fictional_a",
    amountMinor: 150000,
    currency: "PYG",
    reference: "ORD-9001",
    customerName: "Elena Valenzuela",
    settledAt: new Date("2026-10-10T14:00:00Z"),
    refundedMinor: 0,
    ...overrides,
  };
}

const run = (payments: SettledPayment[], orders: Order[]) =>
  reconcileBatch(payments, orders, DEFAULT_MATCHING_CONFIG);

const earlier = makePayment({ id: "201", providerPaymentId: "pay_fictional_z" });
const later = makePayment({
  id: "102",
  providerPaymentId: "pay_fictional_a",
  settledAt: new Date("2026-10-10T15:00:00Z"),
});

describe("reconcileBatch", () => {
  it("lets the earliest settled payment claim an order and marks later ones duplicate", () => {
    expect(run([later, earlier], [makeOrder()])).toEqual([
      {
        paymentId: "201",
        decision: { status: "matched", orderId: "1", stage: "exact_reference", confidence: null },
      },
      {
        paymentId: "102",
        decision: { status: "duplicate", orderId: "1", stage: "exact_reference", confidence: null },
      },
    ]);
  });

  it("breaks equal settlement times by provider payment ID", () => {
    const second = makePayment({ id: "1", providerPaymentId: "pay_fictional_b" });
    const first = makePayment({ id: "2", providerPaymentId: "pay_fictional_a" });
    expect(run([second, first], [makeOrder()]).map((result) => result.paymentId)).toEqual([
      "2",
      "1",
    ]);
  });

  it("removes a claimed order from the amount and time window of later payments", () => {
    const anonymous = { ...later, reference: null, customerName: null };
    const result = run([anonymous, earlier], [makeOrder(), makeOrder({ id: "2", orderRef: "X" })]);
    expect(result[1]).toEqual({
      paymentId: "102",
      decision: { status: "matched", orderId: "2", stage: "amount_time_window", confidence: null },
    });
  });

  it("does not claim an order on an amount mismatch", () => {
    const underpaid = { ...earlier, amountMinor: 140000 };
    expect(run([later, underpaid], [makeOrder()]).map((result) => result.decision.status)).toEqual([
      "amount_mismatch",
      "matched",
    ]);
  });

  it("does not claim an order on a full refund", () => {
    const refunded = { ...earlier, refundedMinor: 150000 };
    expect(run([later, refunded], [makeOrder()])).toEqual([
      {
        paymentId: "201",
        decision: { status: "refunded", orderId: "1", stage: "exact_reference", confidence: null },
      },
      {
        paymentId: "102",
        decision: { status: "matched", orderId: "1", stage: "exact_reference", confidence: null },
      },
    ]);
  });

  it("gives the same results whatever the input order", () => {
    const anonymous = makePayment({
      id: "103",
      providerPaymentId: "pay_fictional_m",
      reference: null,
    });
    const orders = [makeOrder(), makeOrder({ id: "2", orderRef: "ORD-9002" })];
    const expected = JSON.stringify(run([earlier, later, anonymous], orders));
    expect(JSON.stringify(run([anonymous, later, earlier], [...orders].reverse()))).toBe(expected);
    expect(JSON.stringify(run([later, anonymous, earlier], orders))).toBe(expected);
  });

  it("returns nothing for no payments", () => {
    expect(run([], [makeOrder()])).toEqual([]);
  });
});
