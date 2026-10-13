// Renders the exceptions report for people (Markdown) and spreadsheets (CSV).
// Payer-entered text is untrusted, so both formats neutralize it.
import { formatCsvRow } from "../csv.js";
import { formatMinorUnits } from "../money.js";
import type { ExceptionItem, ExceptionReport, ExceptionStatus } from "./exceptions.js";

interface Section {
  title: string;
  includes: (item: ExceptionItem) => boolean;
}

const statusSection = (title: string, status: ExceptionStatus): Section => ({
  title,
  includes: (item) => item.status === status,
});

// A payment can appear in several sections, e.g. unmatched and with anomalies.
const SECTIONS: readonly Section[] = [
  statusSection("Ambiguous", "ambiguous"),
  statusSection("Unmatched", "unmatched"),
  statusSection("Amount mismatch", "amount_mismatch"),
  statusSection("Duplicate", "duplicate"),
  statusSection("Refunded", "refunded"),
  statusSection("Awaiting settlement", "awaiting_settlement"),
  statusSection("Not reconciled yet", "not_reconciled"),
  { title: "Partial refunds", includes: (item) => item.partialRefund },
  { title: "Payment anomalies", includes: (item) => item.anomalies.length > 0 },
  { title: "Outdated results", includes: (item) => item.resultOutdated },
];

const EMPTY_CELL = "-";
const MARKDOWN_SPECIAL = /[\\|*_`[\]<>#]/g;

/** Keeps payer text inside its table cell and stops it adding markup. */
function markdownCell(text: string | null): string {
  if (text === null || text === "") return EMPTY_CELL;
  return text
    .replace(/\r\n|\r|\n/g, " ")
    .replace(MARKDOWN_SPECIAL, (character) => `\\${character}`);
}

function formatAmount(item: ExceptionItem): string {
  return item.amountMinor === null || item.currency === null
    ? EMPTY_CELL
    : formatMinorUnits(item.amountMinor, item.currency);
}

/** Before settlement the currency is unknown, so the total stays in minor units. */
function formatRefunded(item: ExceptionItem): string {
  return item.currency === null
    ? `${item.refundedMinor} (minor units)`
    : formatMinorUnits(BigInt(item.refundedMinor), item.currency);
}

function detail(item: ExceptionItem): string | null {
  const parts = [
    item.stage === null ? null : `stage ${item.stage}`,
    item.confidence === null ? null : `confidence ${item.confidence}`,
    item.candidateOrderRefs.length === 0
      ? null
      : `candidates ${item.candidateOrderRefs.join(", ")}`,
    item.anomalies.length === 0 ? null : `anomalies ${item.anomalies.join(", ")}`,
    item.resultOutdated ? "payment changed after the last run; rerun reconcile" : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join("; ");
}

const TABLE_HEADER = [
  "| Payment | Amount | Refunded | Settled (UTC) | Reference | Customer | Order | Detail |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
];

function markdownRow(item: ExceptionItem): string {
  const cells = [
    markdownCell(item.providerPaymentId),
    formatAmount(item),
    formatRefunded(item),
    item.settledAt?.toISOString() ?? EMPTY_CELL,
    markdownCell(item.reference),
    markdownCell(item.customerName),
    markdownCell(item.orderRef),
    markdownCell(detail(item)),
  ];
  return `| ${cells.join(" | ")} |`;
}

export function renderMarkdown(report: ExceptionReport): string {
  const sections = SECTIONS.map((section) => ({
    title: section.title,
    items: report.items.filter(section.includes),
  }));
  const lines = [
    "# Exceptions report",
    "",
    `- Generated: ${report.generatedAt.toISOString()}`,
    `- Day (UTC): ${report.day ?? "all days"}`,
    `- Last reconcile run: ${report.lastReconciledAt?.toISOString() ?? "never"}`,
    `- Payments needing attention: ${String(report.items.length)}`,
    "",
    "| Section | Payments |",
    "| --- | --- |",
    ...sections.map(({ title, items }) => `| ${title} | ${String(items.length)} |`),
    "",
  ];
  if (report.items.length === 0) lines.push("No payments need attention.", "");
  for (const { title, items } of sections) {
    if (items.length === 0) continue;
    lines.push(`## ${title}`, "", ...TABLE_HEADER, ...items.map(markdownRow), "");
  }
  return lines.join("\n");
}

const CSV_COLUMNS = [
  "provider_payment_id",
  "status",
  "amount_minor",
  "currency",
  "refunded_minor",
  "settled_at",
  "reference",
  "customer_name",
  "order_ref",
  "stage",
  "confidence",
  "candidate_order_refs",
  "partial_refund",
  "anomalies",
  "result_outdated",
];

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/**
 * Spreadsheets run a cell that starts with = + - @ as a formula. A leading
 * apostrophe makes it plain text. No value this report generates is negative,
 * so the guard never changes one of its own numbers.
 */
function csvCell(text: string | null): string {
  if (text === null) return "";
  return FORMULA_PREFIX.test(text) ? `'${text}` : text;
}

function csvRow(item: ExceptionItem): string {
  return formatCsvRow(
    [
      item.providerPaymentId,
      item.status,
      item.amountMinor === null ? null : String(item.amountMinor),
      item.currency,
      item.refundedMinor,
      item.settledAt?.toISOString() ?? null,
      item.reference,
      item.customerName,
      item.orderRef,
      item.stage,
      item.confidence,
      item.candidateOrderRefs.join(" "),
      String(item.partialRefund),
      item.anomalies.join(" "),
      String(item.resultOutdated),
    ].map(csvCell),
  );
}

/** RFC 4180 CSV with CRLF line endings and a header row. */
export function renderCsv(report: ExceptionReport): string {
  return [formatCsvRow(CSV_COLUMNS), ...report.items.map(csvRow), ""].join("\r\n");
}
