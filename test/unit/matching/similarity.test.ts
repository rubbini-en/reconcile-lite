import { describe, expect, it } from "vitest";
import { jaroWinkler, roundScore, toThousandths } from "../../../src/matching/similarity.js";

describe("jaroWinkler", () => {
  it("matches identical strings with 1", () => {
    expect(jaroWinkler("abc", "abc")).toBe(1);
    expect(jaroWinkler("", "")).toBe(1);
    expect(jaroWinkler("maria", "maria")).toBe(1);
  });

  it("returns 0 when one string is empty and the other is not", () => {
    expect(jaroWinkler("", "ord1042")).toBe(0);
    expect(jaroWinkler("ord1042", "")).toBe(0);
  });

  it("returns 0 for completely disjoint strings", () => {
    expect(jaroWinkler("abc", "xyz")).toBe(0);
  });

  it("calculates classic reference pairs with expected rounded scores", () => {
    // Required classic benchmark pairs:
    // MARTHA / MARHTA = 0.961
    // DWAYNE / DUANE = 0.840
    // DIXON / DICKSONX = 0.813
    expect(roundScore(jaroWinkler("MARTHA", "MARHTA"))).toBe(0.961);
    expect(roundScore(jaroWinkler("DWAYNE", "DUANE"))).toBe(0.84);
    expect(roundScore(jaroWinkler("DIXON", "DICKSONX"))).toBe(0.813);
  });

  it("caps common prefix at 4 characters", () => {
    // Jaro is 0.889 and the common prefix is 5 characters. Capped at 4 the
    // boost gives 0.933; an uncapped prefix would give 0.944.
    expect(roundScore(jaroWinkler("ABCDE1", "ABCDE2"))).toBe(0.933);
  });

  it("scores similar customer names and references accurately", () => {
    expect(roundScore(jaroWinkler("ord1042", "ord1043"))).toBeGreaterThan(0.85);
    expect(roundScore(jaroWinkler("maria benitez", "maria benite"))).toBeGreaterThan(0.95);
  });
});

describe("roundScore", () => {
  it("rounds values to exactly 3 decimal places", () => {
    expect(roundScore(0.961111)).toBe(0.961);
    expect(roundScore(0.84000001)).toBe(0.84);
    expect(roundScore(0.813333)).toBe(0.813);
    expect(roundScore(0.5)).toBe(0.5);
    expect(roundScore(1)).toBe(1);
    expect(roundScore(0)).toBe(0);
  });
});

describe("toThousandths", () => {
  it("converts numbers to integer thousandths", () => {
    expect(toThousandths(0.95)).toBe(950);
    expect(toThousandths(0.9)).toBe(900);
    expect(toThousandths(0.95) - toThousandths(0.9)).toBe(50);
    expect(toThousandths(0.049)).toBe(49);
    expect(toThousandths(0.05)).toBe(50);
  });
});
