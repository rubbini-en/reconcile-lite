import { describe, expect, it } from "vitest";
import { DEFAULT_MATCHING_CONFIG } from "../../../src/domain/types.js";
import type { Order, SettledPayment } from "../../../src/domain/types.js";
import {
  compareNumericIds,
  matchAmountTimeWindow,
  matchExactReference,
  matchFuzzy,
} from "../../../src/matching/stages.js";

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
    providerPaymentId: "pay_test_01",
    amountMinor: 150000,
    currency: "PYG",
    reference: "ORD-9001",
    customerName: "Elena Valenzuela",
    settledAt: new Date("2026-10-10T14:00:00Z"),
    refundedMinor: 0,
    ...overrides,
  };
}

describe("compareNumericIds", () => {
  it("sorts numeric string IDs by numeric value", () => {
    const ids = ["10", "2", "1", "9", "20", "100", "99"];
    ids.sort(compareNumericIds);
    expect(ids).toEqual(["1", "2", "9", "10", "20", "99", "100"]);
  });
});

describe("matchExactReference (Stage a)", () => {
  it("matches when reference matches exactly", () => {
    const order = makeOrder({ id: "5", orderRef: "ORD-9001" });
    const payment = makePayment({ reference: "ORD-9001" });
    const claimed = new Set<string>();

    const result = matchExactReference(payment, [order], claimed);
    expect(result).toEqual({
      status: "matched",
      orderId: "5",
      stage: "exact_reference",
      confidence: null,
    });
  });

  it("trims whitespace from both payment reference and order ref", () => {
    const order = makeOrder({ id: "5", orderRef: "  ORD-9001  " });
    const payment = makePayment({ reference: "ORD-9001 " });
    const claimed = new Set<string>();

    const result = matchExactReference(payment, [order], claimed);
    expect(result).toEqual({
      status: "matched",
      orderId: "5",
      stage: "exact_reference",
      confidence: null,
    });
  });

  it("is case-sensitive and hands over to next stage when cases differ", () => {
    const order = makeOrder({ id: "5", orderRef: "ord-9001" });
    const payment = makePayment({ reference: "ORD-9001" });
    const claimed = new Set<string>();

    const result = matchExactReference(payment, [order], claimed);
    expect(result).toBeNull();
  });

  it("skips stage a when payment reference is null or empty", () => {
    const order = makeOrder({ orderRef: "ORD-9001" });
    const claimed = new Set<string>();

    expect(matchExactReference(makePayment({ reference: null }), [order], claimed)).toBeNull();
    expect(matchExactReference(makePayment({ reference: "" }), [order], claimed)).toBeNull();
    expect(matchExactReference(makePayment({ reference: "   " }), [order], claimed)).toBeNull();
  });

  it("returns amount_mismatch when amountMinor differs", () => {
    const order = makeOrder({
      id: "5",
      orderRef: "ORD-9001",
      amountMinor: 150000,
      currency: "PYG",
    });
    const payment = makePayment({ reference: "ORD-9001", amountMinor: 140000, currency: "PYG" });
    const claimed = new Set<string>();

    const result = matchExactReference(payment, [order], claimed);
    expect(result).toEqual({
      status: "amount_mismatch",
      orderId: "5",
      stage: "exact_reference",
      confidence: null,
    });
  });

  it("returns amount_mismatch when currency differs", () => {
    const order = makeOrder({ id: "5", orderRef: "ORD-9001", amountMinor: 1234, currency: "USD" });
    const payment = makePayment({ reference: "ORD-9001", amountMinor: 1234, currency: "PYG" });
    const claimed = new Set<string>();

    const result = matchExactReference(payment, [order], claimed);
    expect(result).toEqual({
      status: "amount_mismatch",
      orderId: "5",
      stage: "exact_reference",
      confidence: null,
    });
  });

  it("returns duplicate when order is in claimedOrderIds", () => {
    const order = makeOrder({ id: "5", orderRef: "ORD-9001" });
    const payment = makePayment({ reference: "ORD-9001" });
    const claimed = new Set<string>(["5"]);

    const result = matchExactReference(payment, [order], claimed);
    expect(result).toEqual({
      status: "duplicate",
      orderId: "5",
      stage: "exact_reference",
      confidence: null,
    });
  });

  it("returns ambiguous when two orders share the trimmed reference", () => {
    const orders = [makeOrder({ id: "12", orderRef: "ORD-9001 " }), makeOrder({ id: "3" })];
    expect(matchExactReference(makePayment(), orders, new Set())).toEqual({
      status: "ambiguous",
      stage: "exact_reference",
      candidateOrderIds: ["3", "12"],
    });
  });

  it("matches a USD payment by reference", () => {
    const order = makeOrder({ id: "6", amountMinor: 1234, currency: "USD" });
    const payment = makePayment({ amountMinor: 1234, currency: "USD" });
    expect(matchExactReference(payment, [order], new Set())).toEqual({
      status: "matched",
      orderId: "6",
      stage: "exact_reference",
      confidence: null,
    });
  });

  it("prioritizes amount/currency mismatch over duplicate status", () => {
    const order = makeOrder({ id: "5", orderRef: "ORD-9001", amountMinor: 150000 });
    const payment = makePayment({ reference: "ORD-9001", amountMinor: 120000 });
    const claimed = new Set<string>(["5"]);

    const result = matchExactReference(payment, [order], claimed);
    expect(result).toEqual({
      status: "amount_mismatch",
      orderId: "5",
      stage: "exact_reference",
      confidence: null,
    });
  });
});

describe("matchAmountTimeWindow (Stage b)", () => {
  it("matches exactly one candidate within the time window", () => {
    const order = makeOrder({
      id: "7",
      amountMinor: 1234,
      currency: "USD",
      createdAt: new Date("2026-10-10T12:00:00Z"),
    });
    const payment = makePayment({
      amountMinor: 1234,
      currency: "USD",
      settledAt: new Date("2026-10-11T12:00:00Z"), // 24h distance
    });
    const claimed = new Set<string>();

    const result = matchAmountTimeWindow(payment, [order], claimed, DEFAULT_MATCHING_CONFIG);
    expect(result).toEqual({
      status: "matched",
      orderId: "7",
      stage: "amount_time_window",
      confidence: null,
    });
  });

  it("includes boundary at exactly 72h and excludes 72h + 1ms", () => {
    const baseDate = new Date("2026-10-10T12:00:00.000Z");
    const exact72hLater = new Date(baseDate.getTime() + 72 * 3600 * 1000);
    const beyond72hLater = new Date(baseDate.getTime() + 72 * 3600 * 1000 + 1);

    const orderExact = makeOrder({ id: "1", createdAt: baseDate });
    const paymentExact = makePayment({ settledAt: exact72hLater });
    const claimed = new Set<string>();

    expect(
      matchAmountTimeWindow(paymentExact, [orderExact], claimed, DEFAULT_MATCHING_CONFIG),
    ).toEqual({
      status: "matched",
      orderId: "1",
      stage: "amount_time_window",
      confidence: null,
    });

    const paymentBeyond = makePayment({ settledAt: beyond72hLater });
    expect(
      matchAmountTimeWindow(paymentBeyond, [orderExact], claimed, DEFAULT_MATCHING_CONFIG),
    ).toBeNull();
  });

  it("supports payment settled before order creation (symmetric distance)", () => {
    const settledAt = new Date("2026-10-10T12:00:00Z");
    const createdAt = new Date(settledAt.getTime() + 24 * 3600 * 1000); // order created after payment settled

    const order = makeOrder({ id: "8", createdAt });
    const payment = makePayment({ settledAt });
    const claimed = new Set<string>();

    const result = matchAmountTimeWindow(payment, [order], claimed, DEFAULT_MATCHING_CONFIG);
    expect(result).toEqual({
      status: "matched",
      orderId: "8",
      stage: "amount_time_window",
      confidence: null,
    });
  });

  it("ignores claimed orders", () => {
    const order = makeOrder({ id: "8" });
    const payment = makePayment();
    const claimed = new Set<string>(["8"]);

    const result = matchAmountTimeWindow(payment, [order], claimed, DEFAULT_MATCHING_CONFIG);
    expect(result).toBeNull();
  });

  it("ignores orders with different currency or amount", () => {
    const orderDiffCurrency = makeOrder({ id: "1", currency: "USD", amountMinor: 150000 });
    const orderDiffAmount = makeOrder({ id: "2", currency: "PYG", amountMinor: 160000 });
    const payment = makePayment({ currency: "PYG", amountMinor: 150000 });
    const claimed = new Set<string>();

    const result = matchAmountTimeWindow(
      payment,
      [orderDiffCurrency, orderDiffAmount],
      claimed,
      DEFAULT_MATCHING_CONFIG,
    );
    expect(result).toBeNull();
  });

  it("returns ambiguous with candidateOrderIds sorted numerically when 2+ candidates match", () => {
    const order9 = makeOrder({ id: "9" });
    const order10 = makeOrder({ id: "10" });
    const order2 = makeOrder({ id: "2" });
    const payment = makePayment();
    const claimed = new Set<string>();

    // Pass in unsorted order: ["10", "9", "2"]
    const result = matchAmountTimeWindow(
      payment,
      [order10, order9, order2],
      claimed,
      DEFAULT_MATCHING_CONFIG,
    );
    expect(result).toEqual({
      status: "ambiguous",
      stage: "amount_time_window",
      candidateOrderIds: ["2", "9", "10"],
    });
  });
});

describe("matchFuzzy (Stage c)", () => {
  it("matches a candidate meeting threshold with sufficient lead", () => {
    const order = makeOrder({
      id: "1",
      customerName: "Elena Valenzuela",
      orderRef: "ORD-8888",
    });
    // Payment customerName slightly mistyped: "Elena Valenzuela" vs "Elena Valensuela"
    const payment = makePayment({
      customerName: "Elena Valensuela",
      reference: "UNKNOWN",
    });
    const claimed = new Set<string>();

    const result = matchFuzzy(payment, [order], claimed, DEFAULT_MATCHING_CONFIG);
    expect(result.status).toBe("matched");
    if (result.status === "matched") {
      expect(result.orderId).toBe("1");
      expect(result.stage).toBe("fuzzy");
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    }
  });

  it("returns amount_mismatch when fuzzy match succeeds but amounts differ", () => {
    const order = makeOrder({
      id: "1",
      amountMinor: 150000,
      customerName: "Elena Valenzuela",
    });
    const payment = makePayment({
      amountMinor: 140000,
      customerName: "Elena Valenzuela",
      reference: null,
    });
    const claimed = new Set<string>();

    const result = matchFuzzy(payment, [order], claimed, DEFAULT_MATCHING_CONFIG);
    expect(result.status).toBe("amount_mismatch");
    if (result.status === "amount_mismatch") {
      expect(result.orderId).toBe("1");
      expect(result.stage).toBe("fuzzy");
      expect(result.confidence).toBe(1);
    }
  });

  it("handles accents and word order in customer names", () => {
    const order = makeOrder({
      id: "1",
      customerName: "María Benítez",
      orderRef: "ORD-0001",
    });
    const payment = makePayment({
      customerName: "Benitez Maria",
      reference: "MISC-PAY",
    });
    const claimed = new Set<string>();

    const result = matchFuzzy(payment, [order], claimed, DEFAULT_MATCHING_CONFIG);
    expect(result).toEqual({
      status: "matched",
      orderId: "1",
      stage: "fuzzy",
      confidence: 1,
    });
  });

  it("returns unmatched when score is below threshold", () => {
    const order = makeOrder({
      id: "1",
      customerName: "Carlos Benitez",
      orderRef: "ORD-9999",
    });
    const payment = makePayment({
      customerName: "Marcos Gomez",
      reference: "ORD-1111",
    });
    const claimed = new Set<string>();

    const result = matchFuzzy(payment, [order], claimed, DEFAULT_MATCHING_CONFIG);
    expect(result).toEqual({ status: "unmatched" });
  });

  // Reference-only fixtures: the payment has no customer name, so each score is
  // the reference similarity. JW("martha", "marhta") rounds to 0.961.
  const marthaPayment = makePayment({ reference: "MARTHA", customerName: null });

  it.each([
    { threshold: 0.961, expected: "matched" },
    { threshold: 0.962, expected: "unmatched" },
  ])(
    "treats a score equal to the threshold as eligible (threshold $threshold)",
    ({ threshold, expected }) => {
      const order = makeOrder({ id: "1", orderRef: "MARHTA" });
      const config = { ...DEFAULT_MATCHING_CONFIG, fuzzyThreshold: threshold };
      const result = matchFuzzy(marthaPayment, [order], new Set(), config);
      expect(result).toEqual(
        expected === "matched"
          ? { status: "matched", orderId: "1", stage: "fuzzy", confidence: 0.961 }
          : { status: "unmatched" },
      );
    },
  );

  it("picks the best candidate when its lead equals fuzzyMinLead exactly", () => {
    // Scores 1.000 and 0.961: a lead of exactly 39 thousandths.
    const orders = [
      makeOrder({ id: "2", orderRef: "MARHTA" }),
      makeOrder({ id: "1", orderRef: "MARTHA" }),
    ];
    const config = { ...DEFAULT_MATCHING_CONFIG, fuzzyMinLead: 0.039 };
    expect(matchFuzzy(marthaPayment, orders, new Set(), config)).toEqual({
      status: "matched",
      orderId: "1",
      stage: "fuzzy",
      confidence: 1,
    });
  });

  it("returns ambiguous when the lead is one thousandth below fuzzyMinLead", () => {
    const orders = [
      makeOrder({ id: "2", orderRef: "MARHTA" }),
      makeOrder({ id: "1", orderRef: "MARTHA" }),
    ];
    const config = { ...DEFAULT_MATCHING_CONFIG, fuzzyMinLead: 0.04 };
    expect(matchFuzzy(marthaPayment, orders, new Set(), config)).toEqual({
      status: "ambiguous",
      stage: "fuzzy",
      candidateOrderIds: ["1", "2"],
    });
  });

  it("lists only the eligible candidates within fuzzyMinLead of the best, sorted by ID", () => {
    // Against "ord9001": "ord9001" 1.000, "ord9010" 0.971 (within 0.05), "ord9002" 0.943 (not).
    const payment = makePayment({ reference: "ORD-9001", customerName: null });
    const orders = [
      makeOrder({ id: "9", orderRef: "ORD-9002" }),
      makeOrder({ id: "10", orderRef: "ORD-9001" }),
      makeOrder({ id: "2", orderRef: "ORD-9010" }),
    ];
    expect(matchFuzzy(payment, orders, new Set(), DEFAULT_MATCHING_CONFIG)).toEqual({
      status: "ambiguous",
      stage: "fuzzy",
      candidateOrderIds: ["2", "10"],
    });
  });

  it("never picks between candidates tied for the best score, even with no minimum lead", () => {
    const orders = [makeOrder({ id: "4" }), makeOrder({ id: "3" })];
    const config = { ...DEFAULT_MATCHING_CONFIG, fuzzyMinLead: 0 };
    expect(matchFuzzy(makePayment(), orders, new Set(), config)).toEqual({
      status: "ambiguous",
      stage: "fuzzy",
      candidateOrderIds: ["3", "4"],
    });
  });

  it("ignores claimed orders and orders in another currency", () => {
    const claimed = makeOrder({ id: "1" });
    const otherCurrency = makeOrder({ id: "2", currency: "USD", amountMinor: 1234 });
    expect(
      matchFuzzy(makePayment(), [claimed, otherCurrency], new Set(["1"]), DEFAULT_MATCHING_CONFIG),
    ).toEqual({ status: "unmatched" });
  });

  it("includes an order exactly fuzzyWindowHours away", () => {
    const settledAt = new Date("2026-10-10T12:00:00Z");
    const order = makeOrder({
      id: "1",
      createdAt: new Date(settledAt.getTime() - 720 * 3600 * 1000),
    });
    expect(
      matchFuzzy(makePayment({ settledAt }), [order], new Set(), DEFAULT_MATCHING_CONFIG),
    ).toEqual({ status: "matched", orderId: "1", stage: "fuzzy", confidence: 1 });
  });

  it("picks best candidate when one candidate is eligible and another is below threshold", () => {
    const orderEligible = makeOrder({
      id: "1",
      customerName: "Sofia Benitez",
      orderRef: "ORD-9001",
    });
    const orderIneligible = makeOrder({
      id: "2",
      customerName: "Totally Unrelated",
      orderRef: "MISC-9999",
    });
    const payment = makePayment({
      customerName: "Sofia Benitez",
      reference: "MISC-1234",
    });
    const claimed = new Set<string>();

    const result = matchFuzzy(
      payment,
      [orderEligible, orderIneligible],
      claimed,
      DEFAULT_MATCHING_CONFIG,
    );
    expect(result).toEqual({
      status: "matched",
      orderId: "1",
      stage: "fuzzy",
      confidence: 1,
    });
  });

  it("scores 0 when reference or customerName is null or empty (missing data is not evidence)", () => {
    const order = makeOrder({
      id: "1",
      customerName: "",
      orderRef: "",
    });
    const payment = makePayment({
      customerName: null,
      reference: null,
    });
    const claimed = new Set<string>();

    const result = matchFuzzy(payment, [order], claimed, DEFAULT_MATCHING_CONFIG);
    expect(result).toEqual({ status: "unmatched" });
  });

  it("ignores orders outside fuzzyWindowHours", () => {
    const baseDate = new Date("2026-10-10T12:00:00Z");
    // Default fuzzy window is 720 hours (30 days)
    const orderFarPast = makeOrder({
      id: "1",
      createdAt: new Date(baseDate.getTime() - 721 * 3600 * 1000),
      customerName: "Sofia Benitez",
    });
    const payment = makePayment({
      settledAt: baseDate,
      customerName: "Sofia Benitez",
    });
    const claimed = new Set<string>();

    const result = matchFuzzy(payment, [orderFarPast], claimed, DEFAULT_MATCHING_CONFIG);
    expect(result).toEqual({ status: "unmatched" });
  });
});
