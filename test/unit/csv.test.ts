import { describe, expect, it } from "vitest";
import { CsvError, formatCsvRow, parseCsv } from "../../src/csv.js";

const fields = (text: string) => parseCsv(text).map((record) => record.fields);

describe("parseCsv", () => {
  it("splits plain fields and records", () => {
    expect(fields("a,b,c\n1,2,3\n")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("accepts CRLF line endings and a missing final newline", () => {
    expect(fields("a,b\r\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps empty fields", () => {
    expect(fields(",x,\n")).toEqual([["", "x", ""]]);
  });

  it("reads quoted fields with commas, escaped quotes and line breaks", () => {
    expect(fields('"Benítez, María","say ""hi""","line 1\nline 2"\n')).toEqual([
      ["Benítez, María", 'say "hi"', "line 1\nline 2"],
    ]);
  });

  it("strips a UTF-8 byte order mark", () => {
    expect(fields("﻿a,b\n")).toEqual([["a", "b"]]);
  });

  it("skips blank lines and reports the line where each record starts", () => {
    const records = parseCsv('a\n\n"multi\nline"\r\n\r\nb\n');
    expect(records).toEqual([
      { line: 1, fields: ["a"] },
      { line: 3, fields: ["multi\nline"] },
      { line: 6, fields: ["b"] },
    ]);
  });

  it("returns nothing for empty input", () => {
    expect(parseCsv("")).toEqual([]);
  });

  it.each([
    ['a,"unterminated\n', /line 1: unterminated quoted field/],
    ['a,b"c\n', /line 1: quote inside an unquoted field/],
    ['"a"b,c\n', /line 1: unexpected character after a closing quote/],
    ['ok\n"x"y\n', /line 2: unexpected character after a closing quote/],
  ])("rejects malformed input %j", (text, message) => {
    expect(() => parseCsv(text)).toThrow(CsvError);
    expect(() => parseCsv(text)).toThrow(message);
  });
});

describe("formatCsvRow", () => {
  it("quotes only fields that need it and doubles inner quotes", () => {
    expect(formatCsvRow(["plain", "a,b", 'say "hi"', "two\nlines", ""])).toBe(
      'plain,"a,b","say ""hi""","two\nlines",',
    );
  });

  it("round-trips through parseCsv", () => {
    const row = ["Benítez, María", 'x"y', "line\r\nbreak", " padded "];
    expect(fields(`${formatCsvRow(row)}\r\n`)).toEqual([row]);
  });
});
