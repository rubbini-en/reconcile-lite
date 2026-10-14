import { readFile, stat } from "node:fs/promises";
import { createPool } from "../db/pool.js";
import { MAX_ORDERS_FILE_BYTES, OrderImportError, parseOrdersCsv } from "./csv-import.js";
import { importOrders } from "./repository.js";

const [filePath] = process.argv.slice(2);
const databaseUrl = process.env.DATABASE_URL;
if (filePath === undefined) {
  console.error("Usage: npm run import:orders -- <orders.csv>");
  process.exit(1);
}
if (!databaseUrl) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

// Invalid UTF-8 is an error, not silently replaced characters in names.
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

function tooLarge(size: number): OrderImportError {
  return new OrderImportError([
    `the file is ${String(size)} bytes; the maximum is ${String(MAX_ORDERS_FILE_BYTES)}`,
  ]);
}

async function readOrders(path: string) {
  let bytes: Buffer;
  try {
    // Checking the size first avoids loading an oversized file into memory.
    const { size } = await stat(path);
    if (size > MAX_ORDERS_FILE_BYTES) throw tooLarge(size);
    bytes = await readFile(path);
  } catch (error) {
    if (error instanceof OrderImportError) throw error;
    const reason = error instanceof Error && "code" in error ? String(error.code) : "unknown error";
    throw new OrderImportError([`Cannot read ${path} (${reason})`]);
  }
  // The file may have grown between the size check and the read.
  if (bytes.length > MAX_ORDERS_FILE_BYTES) throw tooLarge(bytes.length);
  let text: string;
  try {
    text = strictUtf8.decode(bytes);
  } catch {
    throw new OrderImportError(["the file is not valid UTF-8"]);
  }
  return parseOrdersCsv(text);
}

const pool = createPool(databaseUrl);
try {
  const summary = await importOrders(pool, await readOrders(filePath));
  console.log(
    `Imported ${String(summary.inserted)} new orders, ${String(summary.unchanged)} unchanged.`,
  );
} catch (error) {
  if (!(error instanceof OrderImportError)) throw error;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
