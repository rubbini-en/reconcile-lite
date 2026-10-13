import { describe, expect, it } from "vitest";
import { OrderImportError, parseOrdersCsv } from "../../../src/orders/csv-import.js";

const HEADER = "order_ref,customer_name,amount,currency,created_at";

function problemsOf(text: string): string[] {
  try {
    parseOrdersCsv(text);
  } catch (error) {
    if (error instanceof OrderImportError) return error.problems;
    throw error;
  }
  throw new Error("Expected an OrderImportError");
}

describe("parseOrdersCsv", () => {
  it("converts PYG and USD rows to minor units and UTC dates", () => {
    const text = [
      HEADER,
      "ORD-1001,María Benítez,150000,PYG,2026-10-10T12:00:00Z",
      '"ORD-1002","Acosta, Rodrigo",12.34,USD,2026-10-11T08:30:00.250Z',
      "ORD-1003,Ana Duarte,7.5,USD,2026-10-11T09:00:00Z",
    ].join("\n");
    expect(parseOrdersCsv(text)).toEqual([
      {
        orderRef: "ORD-1001",
        customerName: "María Benítez",
        amountMinor: 150000,
        currency: "PYG",
        createdAt: new Date("2026-10-10T12:00:00Z"),
      },
      {
        orderRef: "ORD-1002",
        customerName: "Acosta, Rodrigo",
        amountMinor: 1234,
        currency: "USD",
        createdAt: new Date("2026-10-11T08:30:00.250Z"),
      },
      {
        orderRef: "ORD-1003",
        customerName: "Ana Duarte",
        amountMinor: 750,
        currency: "USD",
        createdAt: new Date("2026-10-11T09:00:00Z"),
      },
    ]);
  });

  it("trims surrounding whitespace from the reference and the name", () => {
    const [order] = parseOrdersCsv(
      `${HEADER}\n  ORD-1  , Ana Duarte ,1,PYG,2026-10-10T12:00:00Z\n`,
    );
    expect(order).toMatchObject({ orderRef: "ORD-1", customerName: "Ana Duarte" });
  });

  it("requires the exact header", () => {
    expect(problemsOf("ref,name,amount,currency,created_at\n")).toEqual([
      `line 1: header must be "${HEADER}"`,
    ]);
  });

  it("compares header fields one by one, not as joined text", () => {
    const quoted = '"order_ref,customer_name",amount,currency,created_at\n';
    expect(problemsOf(quoted)).toEqual([`line 1: header must be "${HEADER}"`]);
  });

  it("requires at least one order", () => {
    expect(problemsOf(`${HEADER}\n`)).toEqual(["the file contains no orders"]);
    expect(problemsOf("")).toEqual([`line 1: header must be "${HEADER}"`]);
  });

  it("reports every invalid row with its line number and imports nothing", () => {
    const text = [
      HEADER,
      "ORD-1,Ana Duarte,12.345,USD,2026-10-10T12:00:00Z",
      "ORD-2,Ana Duarte,1500.5,PYG,2026-10-10T12:00:00Z",
      "ORD-3,Ana Duarte,10,EUR,2026-10-10T12:00:00Z",
      "ORD-4,Ana Duarte,10,usd,2026-10-10T12:00:00Z",
      "ORD-5,Ana Duarte,10,PYG,2026-10-10T12:00:00",
      "ORD-6,Ana Duarte,10,PYG,2026-02-30T12:00:00Z",
      " ,Ana Duarte,10,PYG,2026-10-10T12:00:00Z",
      "ORD-8,,10,PYG,2026-10-10T12:00:00Z",
      "ORD-9,Ana Duarte,10,PYG",
      "ORD-10,Ana Duarte,0,PYG,2026-10-10T12:00:00Z",
      "ORD-11,Ana Duarte,-5,PYG,2026-10-10T12:00:00Z",
      "ORD-12,Ana Duarte,10,PYG,2026-10-10T12:00:00Z",
      "ORD-12,Ana Duarte,10,PYG,2026-10-10T12:00:00Z",
      `${"R".repeat(129)},Ana Duarte,10,PYG,2026-10-10T12:00:00Z`,
      `ORD-15,${"N".repeat(201)},10,PYG,2026-10-10T12:00:00Z`,
    ].join("\n");
    expect(problemsOf(text)).toEqual([
      'line 2: amount: Amount "12.345" has more decimals than USD allows (2)',
      'line 3: amount: Amount "1500.5" has more decimals than PYG allows (0)',
      'line 4: currency: Unsupported currency "EUR"',
      'line 5: currency: Unsupported currency "usd"',
      "line 6: created_at must be an ISO-8601 UTC timestamp ending in Z",
      "line 7: created_at must be an ISO-8601 UTC timestamp ending in Z",
      "line 8: order_ref must be 1-128 characters",
      "line 9: customer_name must be 1-200 characters",
      "line 10: expected 5 fields, found 4",
      "line 11: amount: Amount must be a positive safe integer in minor units, got 0",
      'line 12: amount: Malformed amount "-5"',
      'line 14: order_ref "ORD-12" already appears on line 13',
      "line 15: order_ref must be 1-128 characters",
      "line 16: customer_name must be 1-200 characters",
    ]);
  });

  it("never echoes the customer name in an error", () => {
    const problems = problemsOf(
      `${HEADER}\nORD-1,Private Payer Name,abc,PYG,2026-10-10T12:00:00Z\n`,
    );
    expect(problems.join("\n")).not.toContain("Private Payer Name");
  });

  it("rejects NUL characters, which Postgres text cannot store", () => {
    expect(problemsOf(`${HEADER}\nORD-1,Ana\u0000Duarte,1,PYG,2026-10-10T12:00:00Z\n`)).toEqual([
      "line 2: fields must not contain NUL characters",
    ]);
  });

  it("reports malformed CSV as one problem", () => {
    expect(problemsOf(`${HEADER}\n"ORD-1,Ana\n`)).toEqual(["line 2: unterminated quoted field"]);
  });
});
