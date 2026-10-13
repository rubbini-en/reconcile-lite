// Turns an orders CSV file into validated orders. All rows are checked before
// anything is imported, and every problem is reported with its line number.
import { CsvError, parseCsv, type CsvRecord } from "../csv.js";
import type { Order } from "../domain/types.js";
import { MoneyError, parseCurrency, parseDecimalAmount } from "../money.js";

export type NewOrder = Omit<Order, "id">;

export class OrderImportError extends Error {
  override name = "OrderImportError";

  constructor(readonly problems: string[]) {
    super(`Order import failed:\n  ${problems.join("\n  ")}`);
  }
}

export const ORDERS_CSV_HEADER = ["order_ref", "customer_name", "amount", "currency", "created_at"];

const MAX_ORDER_REF_LENGTH = 128;
const MAX_CUSTOMER_NAME_LENGTH = 200;
// Milliseconds at most: a JavaScript Date would silently drop finer digits.
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** Rejects impossible dates such as February 30, which Date would roll over. */
function parseUtcTimestamp(text: string): Date | null {
  if (!UTC_TIMESTAMP.test(text)) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 19) === text.slice(0, 19) ? date : null;
}

type FieldResult<T> = { ok: true; value: T } | { ok: false; problem: string };

/** Money parsers throw MoneyError for bad input; anything else is a bug and propagates. */
function moneyField<T>(field: string, parse: () => T): FieldResult<T> {
  try {
    return { ok: true, value: parse() };
  } catch (error) {
    if (error instanceof MoneyError) return { ok: false, problem: `${field}: ${error.message}` };
    throw error;
  }
}

function withinLength(text: string, max: number): boolean {
  return text.length >= 1 && text.length <= max;
}

/** Field values are never echoed except amounts and codes: names are personal data. */
function parseRow(fields: readonly string[]): NewOrder | string {
  if (fields.length !== ORDERS_CSV_HEADER.length) {
    return `expected ${String(ORDERS_CSV_HEADER.length)} fields, found ${String(fields.length)}`;
  }
  if (fields.some((field) => field.includes("\u0000"))) {
    return "fields must not contain NUL characters";
  }
  const [rawRef = "", rawName = "", amountText = "", currencyText = "", createdAtText = ""] =
    fields;
  const orderRef = rawRef.trim();
  const customerName = rawName.trim();
  if (!withinLength(orderRef, MAX_ORDER_REF_LENGTH)) {
    return `order_ref must be 1-${String(MAX_ORDER_REF_LENGTH)} characters`;
  }
  if (!withinLength(customerName, MAX_CUSTOMER_NAME_LENGTH)) {
    return `customer_name must be 1-${String(MAX_CUSTOMER_NAME_LENGTH)} characters`;
  }
  const currency = moneyField("currency", () => parseCurrency(currencyText));
  if (!currency.ok) return currency.problem;
  const amount = moneyField("amount", () => parseDecimalAmount(amountText, currency.value));
  if (!amount.ok) return amount.problem;
  const createdAt = parseUtcTimestamp(createdAtText);
  if (createdAt === null) return "created_at must be an ISO-8601 UTC timestamp ending in Z";
  return {
    orderRef,
    customerName,
    amountMinor: amount.value,
    currency: currency.value,
    createdAt,
  };
}

function readRecords(text: string): CsvRecord[] {
  try {
    return parseCsv(text);
  } catch (error) {
    if (error instanceof CsvError) throw new OrderImportError([error.message]);
    throw error;
  }
}

export function parseOrdersCsv(text: string): NewOrder[] {
  const [header, ...rows] = readRecords(text);
  if (header?.fields.join(",") !== ORDERS_CSV_HEADER.join(",")) {
    throw new OrderImportError([`line 1: header must be "${ORDERS_CSV_HEADER.join(",")}"`]);
  }
  if (rows.length === 0) throw new OrderImportError(["the file contains no orders"]);

  const orders: NewOrder[] = [];
  const problems: string[] = [];
  const firstLineByRef = new Map<string, number>();
  for (const { line, fields } of rows) {
    const parsed = parseRow(fields);
    if (typeof parsed === "string") {
      problems.push(`line ${String(line)}: ${parsed}`);
      continue;
    }
    const firstLine = firstLineByRef.get(parsed.orderRef);
    if (firstLine !== undefined) {
      problems.push(
        `line ${String(line)}: order_ref "${parsed.orderRef}" already appears on line ${String(firstLine)}`,
      );
      continue;
    }
    firstLineByRef.set(parsed.orderRef, line);
    orders.push(parsed);
  }
  if (problems.length > 0) throw new OrderImportError(problems);
  return orders;
}
