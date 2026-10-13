import { describe, expect, it } from "vitest";
import { formatSummary } from "../../../src/reconcile/run.js";

describe("formatSummary", () => {
  it("lists every status in a fixed order, including zero counts", () => {
    const text = formatSummary({
      reconciledAt: new Date("2026-10-13T09:00:00Z"),
      total: 3,
      byStatus: {
        matched: 2,
        ambiguous: 0,
        unmatched: 1,
        amount_mismatch: 0,
        duplicate: 0,
        refunded: 0,
      },
    });
    expect(text).toBe(
      [
        "Reconciled 3 settled payments at 2026-10-13T09:00:00.000Z",
        "  matched         2",
        "  ambiguous       0",
        "  unmatched       1",
        "  amount_mismatch 0",
        "  duplicate       0",
        "  refunded        0",
      ].join("\n"),
    );
  });
});
