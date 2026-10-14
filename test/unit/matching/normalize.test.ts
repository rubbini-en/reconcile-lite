import { describe, expect, it } from "vitest";
import {
  normalizeName,
  normalizeReference,
  normalizeText,
} from "../../../src/matching/normalize.js";

describe("normalizeText", () => {
  it("decomposes accents, lowercases, replaces non-alphanumerics with space, and trims", () => {
    expect(normalizeText("  María  BENÍTEZ-López ")).toBe("maria benitez lopez");
  });

  it("handles various Latin diacritics and symbols", () => {
    expect(normalizeText("Ángel Núñez")).toBe("angel nunez");
    expect(normalizeText("Müller & François")).toBe("muller francois");
  });

  it("collapses multiple punctuation marks and whitespace into single spaces", () => {
    expect(normalizeText("Ref: #1042 / A-B-C")).toBe("ref 1042 a b c");
    expect(normalizeText("hello\t\n  world")).toBe("hello world");
  });

  it("folds dotted capital İ to plain i, leaving no stray combining mark", () => {
    expect(normalizeText("İstanbul")).toBe("istanbul");
  });

  it("keeps dotless ı as its own letter (a known limit)", () => {
    expect(normalizeText("Iğdır")).toBe("igdır");
  });

  it("returns an empty string for null, undefined, or empty string", () => {
    expect(normalizeText(null)).toBe("");
    expect(normalizeText(undefined)).toBe("");
    expect(normalizeText("")).toBe("");
  });

  it("returns an empty string when input contains only whitespace and non-alphanumeric chars", () => {
    expect(normalizeText("   ---   ")).toBe("");
    expect(normalizeText(" _ - ! ? # @ ")).toBe("");
  });
});

describe("normalizeReference", () => {
  it("normalizes reference variants to identical compact strings", () => {
    expect(normalizeReference("ORD-1042")).toBe("ord1042");
    expect(normalizeReference("ord 1042")).toBe("ord1042");
    expect(normalizeReference("Ord_1042")).toBe("ord1042");
  });

  it("removes all spaces from text containing multiple segments", () => {
    expect(normalizeReference("  REF / 9988 - 01  ")).toBe("ref998801");
    expect(normalizeReference("PAY_INV#2026/001")).toBe("payinv2026001");
  });

  it("returns an empty string for null, undefined, or empty string", () => {
    expect(normalizeReference(null)).toBe("");
    expect(normalizeReference(undefined)).toBe("");
    expect(normalizeReference("")).toBe("");
  });

  it("returns an empty string for references with only non-alphanumeric characters", () => {
    expect(normalizeReference("  --  ")).toBe("");
    expect(normalizeReference("###")).toBe("");
  });
});

describe("normalizeName", () => {
  it("sorts name tokens alphabetically so word order does not matter", () => {
    expect(normalizeName("Benítez María")).toBe("benitez maria");
    expect(normalizeName("maria benitez")).toBe("benitez maria");
  });

  it("handles multi-token names regardless of order", () => {
    expect(normalizeName(" Carlos   Alberto   SOSA  ")).toBe("alberto carlos sosa");
    expect(normalizeName("SOSA ALBERTO CARLOS")).toBe("alberto carlos sosa");
    expect(normalizeName("Alberto Sosa Carlos")).toBe("alberto carlos sosa");
  });

  it("handles names with punctuation like commas and hyphens", () => {
    expect(normalizeName("Gómez-Castro, Laura")).toBe("castro gomez laura");
    expect(normalizeName("Laura Gómez Castro")).toBe("castro gomez laura");
  });

  it("returns single token unchanged after normalization", () => {
    expect(normalizeName("María")).toBe("maria");
  });

  it("returns an empty string for null, undefined, empty, or whitespace-only inputs", () => {
    expect(normalizeName(null)).toBe("");
    expect(normalizeName(undefined)).toBe("");
    expect(normalizeName("")).toBe("");
    expect(normalizeName("   ---   ")).toBe("");
  });
});
