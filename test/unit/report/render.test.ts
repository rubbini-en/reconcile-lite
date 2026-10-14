import { describe, expect, it } from "vitest";
import { parseCsv } from "../../../src/csv.js";
import type { ExceptionItem, ExceptionReport } from "../../../src/report/exceptions.js";
import { renderCsv, renderMarkdown } from "../../../src/report/render.js";

function item(providerPaymentId: string, fields: Partial<ExceptionItem>): ExceptionItem {
  return {
    providerPaymentId,
    status: "matched",
    amountMinor: 150000,
    currency: "PYG",
    refundedMinor: "0",
    settledAt: new Date("2026-10-10T14:00:00Z"),
    reference: null,
    customerName: null,
    orderRef: null,
    stage: null,
    confidence: null,
    candidateOrderRefs: [],
    partialRefund: false,
    anomalies: [],
    resultOutdated: false,
    ...fields,
  };
}

const report: ExceptionReport = {
  generatedAt: new Date("2026-10-13T12:00:00Z"),
  day: "2026-10-10",
  lastReconciledAt: new Date("2026-10-13T09:00:00Z"),
  nextCursor: null,
  items: [
    item("pay_ambiguous", {
      status: "ambiguous",
      amountMinor: 1234,
      currency: "USD",
      stage: "amount_time_window",
      candidateOrderRefs: ["ORD-4004", "ORD-5005"],
    }),
    item("pay_fuzzy", {
      status: "amount_mismatch",
      amountMinor: 98000,
      customerName: "Carla Roxas",
      orderRef: "ORD-3003",
      stage: "fuzzy",
      confidence: "0.964",
    }),
    item("pay_partial", {
      refundedMinor: "30000",
      reference: "ORD-2002",
      orderRef: "ORD-2002",
      stage: "exact_reference",
      partialRefund: true,
      anomalies: ["refunds_exceed_amount"],
    }),
    item("pay_waiting", {
      status: "awaiting_settlement",
      amountMinor: null,
      currency: null,
      refundedMinor: "5000",
      settledAt: null,
    }),
  ],
};

describe("renderMarkdown", () => {
  it("renders a summary and one section per kind of problem", () => {
    expect(renderMarkdown(report)).toBe(
      [
        "# Exceptions report",
        "",
        "- Generated: 2026-10-13T12:00:00.000Z",
        "- Day (UTC): 2026-10-10",
        "- Last reconcile run: 2026-10-13T09:00:00.000Z",
        "- Payments needing attention: 4",
        "",
        "| Section | Payments |",
        "| --- | --- |",
        "| Ambiguous | 1 |",
        "| Unmatched | 0 |",
        "| Amount mismatch | 1 |",
        "| Duplicate | 0 |",
        "| Refunded | 0 |",
        "| Awaiting settlement | 1 |",
        "| Not reconciled yet | 0 |",
        "| Partial refunds | 1 |",
        "| Payment anomalies | 1 |",
        "| Outdated results | 0 |",
        "",
        "## Ambiguous",
        "",
        "| Payment | Amount | Refunded | Settled (UTC) | Reference | Customer | Order | Detail |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        "| pay\\_ambiguous | 12.34 USD | 0.00 USD | 2026-10-10T14:00:00.000Z | - | - | - | stage amount\\_time\\_window; candidates ORD-4004, ORD-5005 |",
        "",
        "## Amount mismatch",
        "",
        "| Payment | Amount | Refunded | Settled (UTC) | Reference | Customer | Order | Detail |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        "| pay\\_fuzzy | 98000 PYG | 0 PYG | 2026-10-10T14:00:00.000Z | - | Carla Roxas | ORD-3003 | stage fuzzy; confidence 0.964 |",
        "",
        "## Awaiting settlement",
        "",
        "| Payment | Amount | Refunded | Settled (UTC) | Reference | Customer | Order | Detail |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        "| pay\\_waiting | - | 5000 (minor units) | - | - | - | - | - |",
        "",
        "## Partial refunds",
        "",
        "| Payment | Amount | Refunded | Settled (UTC) | Reference | Customer | Order | Detail |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        "| pay\\_partial | 150000 PYG | 30000 PYG | 2026-10-10T14:00:00.000Z | ORD-2002 | - | ORD-2002 | stage exact\\_reference; anomalies refunds\\_exceed\\_amount |",
        "",
        "## Payment anomalies",
        "",
        "| Payment | Amount | Refunded | Settled (UTC) | Reference | Customer | Order | Detail |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        "| pay\\_partial | 150000 PYG | 30000 PYG | 2026-10-10T14:00:00.000Z | ORD-2002 | - | ORD-2002 | stage exact\\_reference; anomalies refunds\\_exceed\\_amount |",
        "",
      ].join("\n"),
    );
  });

  it("escapes payer text so it cannot break the table or add markup", () => {
    const text = renderMarkdown({
      ...report,
      items: [
        item("pay_x", {
          status: "unmatched",
          customerName: "Ana | <b>Duarte</b>\n*bold* [link](x) `code` # \\",
        }),
      ],
    });
    expect(text).toContain(
      "| Ana \\| \\<b\\>Duarte\\</b\\> \\*bold\\* \\[link\\](x) \\`code\\` \\# \\\\ |",
    );
  });

  it("formats refund totals above 2^53 - 1 exactly", () => {
    const text = renderMarkdown({
      ...report,
      items: [item("pay_big", { status: "refunded", refundedMinor: "9007199254740993" })],
    });
    expect(text).toContain("| 9007199254740993 PYG |");
  });

  it("says so when nothing needs attention", () => {
    const text = renderMarkdown({ ...report, day: null, lastReconciledAt: null, items: [] });
    expect(text).toContain("- Day (UTC): all days");
    expect(text).toContain("- Last reconcile run: never");
    expect(text.endsWith("No payments need attention.\n")).toBe(true);
  });
});

describe("renderCsv", () => {
  it("writes one CRLF row per payment with machine-readable values", () => {
    expect(renderCsv(report)).toBe(
      [
        "provider_payment_id,status,amount_minor,currency,refunded_minor,settled_at,reference,customer_name,order_ref,stage,confidence,candidate_order_refs,partial_refund,anomalies,result_outdated",
        "pay_ambiguous,ambiguous,1234,USD,0,2026-10-10T14:00:00.000Z,,,,amount_time_window,,ORD-4004 ORD-5005,false,,false",
        "pay_fuzzy,amount_mismatch,98000,PYG,0,2026-10-10T14:00:00.000Z,,Carla Roxas,ORD-3003,fuzzy,0.964,,false,,false",
        "pay_partial,matched,150000,PYG,30000,2026-10-10T14:00:00.000Z,ORD-2002,,ORD-2002,exact_reference,,,true,refunds_exceed_amount,false",
        "pay_waiting,awaiting_settlement,,,5000,,,,,,,,false,,false",
        "",
      ].join("\r\n"),
    );
  });

  it("neutralizes cells a spreadsheet would run as formulas", () => {
    const csv = renderCsv({
      ...report,
      items: [
        item("pay_x", {
          status: "unmatched",
          reference: "=HYPERLINK(1)",
          customerName: "+1, -2",
        }),
      ],
    });
    expect(csv.split("\r\n")[1]).toBe(
      "pay_x,unmatched,150000,PYG,0,2026-10-10T14:00:00.000Z,'=HYPERLINK(1),\"'+1, -2\",,,,,false,,false",
    );
  });

  const referenceCell = (reference: string) => {
    const csv = renderCsv({
      ...report,
      items: [item("pay_x", { status: "unmatched", reference })],
    });
    return parseCsv(csv)[1]?.fields[6];
  };

  it.each([
    ["a leading space", " =1+1"],
    ["a leading vertical tab", "\u000B=1+1"],
    ["a leading no-break space", "\u00A0+1"],
    ["a leading NUL", "\u0000@SUM(A1)"],
    ["a leading control character on its own", "\u001Fdata"],
    ["a leading DEL", "\u007F=1"],
  ])("neutralizes a cell with %s", (_label, reference) => {
    expect(referenceCell(reference)).toBe(`'${reference}`);
  });

  it.each(["Ana Duarte", "a=b", " Ana", "ORD-1001"])("leaves %j unchanged", (reference) => {
    expect(referenceCell(reference)).toBe(reference);
  });

  it("does not print a refund total that mixes currencies before settlement", () => {
    const mixed = item("pay_mixed", {
      status: "awaiting_settlement",
      amountMinor: null,
      currency: null,
      refundedMinor: "1600",
      settledAt: null,
      anomalies: ["refund_currency_mismatch"],
    });
    const markdown = renderMarkdown({ ...report, items: [mixed] });
    expect(markdown).toContain("| pay\\_mixed | - | mixed currencies (see anomalies) |");
    expect(markdown).not.toContain("1600");
    // CSV and JSON keep the raw total; they carry the anomaly flag next to it.
    expect(renderCsv({ ...report, items: [mixed] })).toContain(",1600,");
  });
});
