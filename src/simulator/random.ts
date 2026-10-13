// Seeded randomness, so a simulator run can be repeated exactly. xorshift32
// (Marsaglia, "Xorshift RNGs", 2003) is plenty for shuffling test deliveries;
// it is not suitable for anything security-related.

export function createRandom(seed: number): () => number {
  // Small seeds (1, 2, ...) make xorshift start with nearly-zero output; a
  // multiplicative hash (Knuth) spreads them first. A zero state would stay zero.
  let state = Math.imul(seed >>> 0, 0x9e3779b1) >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

/** Fisher-Yates shuffle into a new array. */
export function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    const current = shuffled[index] as T;
    shuffled[index] = shuffled[other] as T;
    shuffled[other] = current;
  }
  return shuffled;
}
