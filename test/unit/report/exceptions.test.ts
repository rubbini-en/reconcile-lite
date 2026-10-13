import { describe, expect, it } from "vitest";
import {
  ReportError,
  isException,
  parseReportDay,
  type ExceptionItem,
} from "../../../src/report/exceptions.js";

const clean: ExceptionItem = {
  providerPaymentId: "pay_fictional_01",
  status: "matched",
  amountMinor: 150000,
  currency: "PYG",
  refundedMinor: "0",
  settledAt: new Date("2026-10-10T14:00:00Z"),
  reference: "ORD-1001",
  customerName: "Ana Duarte",
  orderRef: "ORD-1001",
  stage: "exact_reference",
  confidence: null,
  candidateOrderRefs: [],
  partialRefund: false,
  anomalies: [],
  resultOutdated: false,
};

describe("isException", () => {
  it("leaves out a clean match", () => {
    expect(isException(clean)).toBe(false);
  });

  it.each([
    ["an unresolved status", { status: "unmatched" as const }],
    ["a payment awaiting settlement", { status: "awaiting_settlement" as const }],
    ["a payment not reconciled yet", { status: "not_reconciled" as const }],
    ["a partial refund", { partialRefund: true }],
    ["an anomaly", { anomalies: ["multiple_settlements" as const] }],
    ["an outdated result", { resultOutdated: true }],
  ])("includes a match with %s", (_label, change) => {
    expect(isException({ ...clean, ...change })).toBe(true);
  });
});

describe("parseReportDay", () => {
  it("returns the UTC day as a half-open range", () => {
    expect(parseReportDay("2026-10-10")).toEqual({
      day: "2026-10-10",
      start: new Date("2026-10-10T00:00:00Z"),
      end: new Date("2026-10-11T00:00:00Z"),
    });
  });

  it("crosses month and year ends", () => {
    expect(parseReportDay("2026-12-31").end).toEqual(new Date("2027-01-01T00:00:00Z"));
  });

  it.each(["2026-02-30", "2026-13-01", "2026-1-01", "20261010", "2026-10-10T00:00:00Z", ""])(
    "rejects %j",
    (text) => {
      expect(() => parseReportDay(text)).toThrow(ReportError);
      expect(() => parseReportDay(text)).toThrow("day must be a calendar date as YYYY-MM-DD");
    },
  );
});
