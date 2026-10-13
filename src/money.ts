// Money is always an integer number of minor units plus a currency code.
// Amounts are capped at Number.MAX_SAFE_INTEGER: JSON.parse cannot represent
// larger integers exactly, so a bigger value could never arrive intact anyway.

/** Minor-unit exponent per supported ISO-4217 currency. */
const CURRENCY_EXPONENTS = {
  PYG: 0,
  USD: 2,
} as const;

export type CurrencyCode = keyof typeof CURRENCY_EXPONENTS;

export class MoneyError extends Error {
  override name = "MoneyError";
}

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === "string" && Object.hasOwn(CURRENCY_EXPONENTS, value);
}

export function parseCurrency(value: unknown): CurrencyCode {
  if (!isCurrencyCode(value)) {
    throw new MoneyError(`Unsupported currency ${JSON.stringify(value)}`);
  }
  return value;
}

export function currencyExponent(currency: CurrencyCode): number {
  return CURRENCY_EXPONENTS[currency];
}

/** Validates an amount that is already in minor units (e.g. from a webhook). */
export function parseMinorUnits(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new MoneyError(
      `Amount must be a positive safe integer in minor units, got ${String(value)}`,
    );
  }
  return value;
}

const DECIMAL_AMOUNT = /^(\d+)(?:\.(\d+))?$/;

/**
 * Converts a human-written decimal amount ("12.34") to minor units without
 * floating-point arithmetic. Extra decimals are rejected, never rounded.
 */
export function parseDecimalAmount(text: string, currency: CurrencyCode): number {
  const match = DECIMAL_AMOUNT.exec(text);
  if (!match) {
    throw new MoneyError(`Malformed amount ${JSON.stringify(text)}`);
  }
  const [, wholePart = "", fractionPart] = match;
  const exponent = currencyExponent(currency);

  if (fractionPart !== undefined && (exponent === 0 || fractionPart.length > exponent)) {
    throw new MoneyError(
      `Amount ${JSON.stringify(text)} has more decimals than ${currency} allows (${String(exponent)})`,
    );
  }

  const minorDigits = wholePart + (fractionPart ?? "").padEnd(exponent, "0");
  const minorUnits = BigInt(minorDigits);
  if (minorUnits > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new MoneyError(`Amount ${JSON.stringify(text)} is too large`);
  }
  return parseMinorUnits(Number(minorUnits));
}

/**
 * Converts a BIGINT column value (node-postgres returns it as a string) to a
 * number. Zero is allowed because refund totals start at 0.
 */
export function minorUnitsFromDb(text: string): number {
  if (!/^\d+$/.test(text) || BigInt(text) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new MoneyError(
      `Database amount ${JSON.stringify(text)} is not a safe minor-unit integer`,
    );
  }
  return Number(text);
}

/**
 * Formats minor units as a plain decimal string, e.g. "12.34 USD". Accepts
 * bigint for stored totals that may exceed 2^53 − 1.
 */
export function formatMinorUnits(minorUnits: number | bigint, currency: CurrencyCode): string {
  const exponent = currencyExponent(currency);
  if (exponent === 0) {
    return `${String(minorUnits)} ${currency}`;
  }
  const digits = String(minorUnits).padStart(exponent + 1, "0");
  const whole = digits.slice(0, -exponent);
  const fraction = digits.slice(-exponent);
  return `${whole}.${fraction} ${currency}`;
}
