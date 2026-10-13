/**
 * Normalization utilities for references and customer names.
 * Pure functions: deterministic, no I/O, no side effects.
 */

/**
 * Normalizes text:
 * 1. Unicode NFD decomposition.
 * 2. Remove combining marks (\p{M}).
 * 3. Lowercase.
 * 4. Replace every non-alphanumeric character with a space.
 * 5. Collapse whitespace and trim.
 *
 * Returns "" for null, undefined, or inputs that normalize to empty.
 */
export function normalizeText(s: string | null | undefined): string {
  if (s == null) {
    return "";
  }
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Normalizes an order or payment reference:
 * Runs normalizeText, then removes all remaining spaces.
 * E.g. "ORD-1042", "ord 1042", and "Ord_1042" all produce "ord1042".
 */
export function normalizeReference(s: string | null | undefined): string {
  const text = normalizeText(s);
  if (text.length === 0) {
    return "";
  }
  return text.replaceAll(" ", "");
}

/**
 * Normalizes a customer name:
 * Runs normalizeText, splits into tokens, sorts tokens alphabetically,
 * and joins them with a single space so word order does not affect matching.
 * E.g. "Benítez María" and "maria benitez" both produce "benitez maria".
 */
export function normalizeName(s: string | null | undefined): string {
  const text = normalizeText(s);
  if (text.length === 0) {
    return "";
  }
  const tokens = text.split(" ").filter((token) => token.length > 0);
  tokens.sort();
  return tokens.join(" ");
}
