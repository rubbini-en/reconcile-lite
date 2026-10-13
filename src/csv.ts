// A small CSV reader and writer (RFC 4180: comma separator, double-quoted
// fields, "" for a literal quote, CRLF or LF line endings). Written in-house to
// avoid a dependency for the one format this project reads and writes.

export class CsvError extends Error {
  override name = "CsvError";
}

export interface CsvRecord {
  /** 1-based line where the record starts, for error messages. */
  line: number;
  fields: string[];
}

const BYTE_ORDER_MARK = "﻿";

class CsvReader {
  private position = 0;
  private line = 1;

  constructor(private readonly text: string) {}

  records(): CsvRecord[] {
    const records: CsvRecord[] = [];
    while (this.position < this.text.length) {
      if (this.atLineBreak()) {
        // A blank line is skipped rather than read as one empty field.
        this.consumeLineBreak();
        continue;
      }
      const line = this.line;
      records.push({ line, fields: this.readRecord(line) });
    }
    return records;
  }

  private readRecord(line: number): string[] {
    const fields: string[] = [];
    for (;;) {
      fields.push(this.peek() === '"' ? this.readQuoted(line) : this.readUnquoted());
      if (this.position >= this.text.length) return fields;
      if (this.atLineBreak()) {
        this.consumeLineBreak();
        return fields;
      }
      // readQuoted and readUnquoted only stop at a comma, a line break or the end.
      this.position += 1;
    }
  }

  private readUnquoted(): string {
    const start = this.position;
    while (this.position < this.text.length && this.peek() !== "," && !this.atLineBreak()) {
      if (this.peek() === '"') {
        throw new CsvError(`line ${String(this.line)}: quote inside an unquoted field`);
      }
      this.position += 1;
    }
    return this.text.slice(start, this.position);
  }

  private readQuoted(line: number): string {
    this.position += 1;
    let value = "";
    for (;;) {
      if (this.position >= this.text.length) {
        throw new CsvError(`line ${String(line)}: unterminated quoted field`);
      }
      const character = this.peek();
      if (character === '"') {
        if (this.text[this.position + 1] === '"') {
          value += '"';
          this.position += 2;
          continue;
        }
        this.position += 1;
        if (this.position < this.text.length && this.peek() !== "," && !this.atLineBreak()) {
          throw new CsvError(
            `line ${String(this.line)}: unexpected character after a closing quote`,
          );
        }
        return value;
      }
      if (character === "\n") this.line += 1;
      value += character;
      this.position += 1;
    }
  }

  /** The current character, or "" at the end of the text. */
  private peek(): string {
    return this.text.charAt(this.position);
  }

  private atLineBreak(): boolean {
    const character = this.peek();
    return character === "\n" || (character === "\r" && this.text[this.position + 1] === "\n");
  }

  private consumeLineBreak(): void {
    this.position += this.peek() === "\r" ? 2 : 1;
    this.line += 1;
  }
}

/** Parses CSV text into records. Throws CsvError with the line number on bad input. */
export function parseCsv(text: string): CsvRecord[] {
  const body = text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text;
  return new CsvReader(body).records();
}

const NEEDS_QUOTES = /[",\r\n]/;

/** Formats one CSV row, quoting only the fields that need it. */
export function formatCsvRow(fields: readonly string[]): string {
  return fields
    .map((field) => (NEEDS_QUOTES.test(field) ? `"${field.replaceAll('"', '""')}"` : field))
    .join(",");
}
