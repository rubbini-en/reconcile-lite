/**
 * String similarity algorithms and score arithmetic.
 * Pure functions: deterministic, no I/O, no side effects.
 */

/**
 * Standard Jaro distance between two strings.
 * Returns a value in [0, 1].
 */
function jaroDistance(s1: string, s2: string): number {
  if (s1 === s2) {
    return 1;
  }

  const len1 = s1.length;
  const len2 = s2.length;

  if (len1 === 0 || len2 === 0) {
    return 0;
  }

  const matchWindow = Math.floor(Math.max(len1, len2) / 2) - 1;
  const s1Matches = new Array<boolean>(len1).fill(false);
  const s2Matches = new Array<boolean>(len2).fill(false);

  let matches = 0;

  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(len2 - 1, i + matchWindow);

    for (let j = start; j <= end; j++) {
      if (s2Matches[j]) {
        continue;
      }
      if (s1[i] !== s2[j]) {
        continue;
      }
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) {
    return 0;
  }

  let k = 0;
  let transpositions = 0;

  for (let i = 0; i < len1; i++) {
    if (!s1Matches[i]) {
      continue;
    }
    while (!s2Matches[k]) {
      k++;
    }
    if (s1[i] !== s2[k]) {
      transpositions++;
    }
    k++;
  }

  const halfTranspositions = transpositions / 2;
  return (matches / len1 + matches / len2 + (matches - halfTranspositions) / matches) / 3;
}

/**
 * Standard Jaro-Winkler similarity:
 * Jaro distance boosted by common prefix (scale 0.1, max prefix 4).
 * Identical strings give 1; one empty string gives 0.
 */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) {
    return 1;
  }

  if (a.length === 0 || b.length === 0) {
    return 0;
  }

  const jaro = jaroDistance(a, b);
  const maxPrefix = Math.min(4, a.length, b.length);
  let prefix = 0;

  for (let i = 0; i < maxPrefix; i++) {
    if (a[i] === b[i]) {
      prefix++;
    } else {
      break;
    }
  }

  const prefixScale = 0.1;
  return jaro + prefix * prefixScale * (1 - jaro);
}

/**
 * Converts a floating-point score to integer thousandths.
 * All threshold and lead comparisons happen on integer thousandths,
 * avoiding binary floating-point rounding issues (e.g. 0.95 - 0.90 === 50).
 */
export function toThousandths(score: number): number {
  return Math.round(score * 1000);
}

/**
 * Rounds a similarity score in [0, 1] to 3 decimal places.
 */
export function roundScore(score: number): number {
  return Math.round(score * 1000) / 1000;
}
