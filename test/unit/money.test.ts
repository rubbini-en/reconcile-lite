import { describe, expect, it } from "vitest";
import {
  MoneyError,
  formatMinorUnits,
  minorUnitsFromDb,
  parseCurrency,
  parseDecimalAmount,
  parseMinorUnits,
} from "../../src/money.js";

describe("parseCurrency", () => {
  it("accepts supported ISO-4217 codes", () => {
    expect(parseCurrency("PYG")).toBe("PYG");
    expect(parseCurrency("USD")).toBe("USD");
  });

  it.each(["usd", "EUR", "US", "USDD", "", " USD"])("rejects %j", (code) => {
    expect(() => parseCurrency(code)).toThrow(MoneyError);
  });
});

describe("parseMinorUnits", () => {
  it("accepts positive safe integers unchanged", () => {
    expect(parseMinorUnits(1)).toBe(1);
    expect(parseMinorUnits(150000)).toBe(150000);
    expect(parseMinorUnits(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([0, -1, 12.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Infinity, "100", null])(
    "rejects %j",
    (value) => {
      expect(() => parseMinorUnits(value)).toThrow(MoneyError);
    },
  );
});

describe("parseDecimalAmount", () => {
  describe("PYG (0 decimals)", () => {
    it("converts whole guaraníes to minor units 1:1", () => {
      expect(parseDecimalAmount("150000", "PYG")).toBe(150000);
      expect(parseDecimalAmount("1", "PYG")).toBe(1);
    });

    it("rejects any decimal part, even .0, instead of rounding", () => {
      expect(() => parseDecimalAmount("1500.5", "PYG")).toThrow(MoneyError);
      expect(() => parseDecimalAmount("1500.0", "PYG")).toThrow(MoneyError);
    });
  });

  describe("USD (2 decimals)", () => {
    it("converts dollars and cents exactly", () => {
      expect(parseDecimalAmount("12.34", "USD")).toBe(1234);
      expect(parseDecimalAmount("12.3", "USD")).toBe(1230);
      expect(parseDecimalAmount("12", "USD")).toBe(1200);
      expect(parseDecimalAmount("0.01", "USD")).toBe(1);
    });

    it("is exact where binary floating point is not", () => {
      // 0.1 + 0.2 !== 0.3 in floating point; string parsing avoids that class of bug.
      expect(parseDecimalAmount("0.29", "USD")).toBe(29);
      expect(parseDecimalAmount("1.15", "USD")).toBe(115);
      expect(parseDecimalAmount("4.35", "USD")).toBe(435);
    });

    it("rejects more decimals than the currency has", () => {
      expect(() => parseDecimalAmount("12.345", "USD")).toThrow(MoneyError);
    });
  });

  it.each(["", "abc", "1,000", "-5", "+5", "1e3", "1.", ".5", " 12", "0", "0.00"])(
    "rejects malformed or non-positive amount %j",
    (text) => {
      expect(() => parseDecimalAmount(text, "USD")).toThrow(MoneyError);
    },
  );

  it("rejects amounts above the safe integer range", () => {
    expect(() => parseDecimalAmount("90071992547409.92", "USD")).toThrow(MoneyError);
    expect(parseDecimalAmount("90071992547409.91", "USD")).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("formatMinorUnits", () => {
  it("formats using the currency exponent", () => {
    expect(formatMinorUnits(150000, "PYG")).toBe("150000 PYG");
    expect(formatMinorUnits(1234, "USD")).toBe("12.34 USD");
    expect(formatMinorUnits(5, "USD")).toBe("0.05 USD");
    expect(formatMinorUnits(1200, "USD")).toBe("12.00 USD");
  });

  it("round-trips with parseDecimalAmount", () => {
    for (const [text, currency] of [
      ["12.34", "USD"],
      ["0.01", "USD"],
      ["150000", "PYG"],
    ] as const) {
      expect(formatMinorUnits(parseDecimalAmount(text, currency), currency)).toBe(
        `${text} ${currency}`,
      );
    }
  });
});

describe("minorUnitsFromDb", () => {
  it("converts node-postgres BIGINT strings to numbers", () => {
    expect(minorUnitsFromDb("1234")).toBe(1234);
    expect(minorUnitsFromDb("0")).toBe(0);
    expect(minorUnitsFromDb(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("fails instead of silently losing precision", () => {
    expect(() => minorUnitsFromDb("9007199254740993")).toThrow(MoneyError);
  });

  it.each(["", "-1", "1.5", "abc"])("rejects %j", (text) => {
    expect(() => minorUnitsFromDb(text)).toThrow(MoneyError);
  });
});
