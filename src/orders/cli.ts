import { readFile } from "node:fs/promises";
import { createPool } from "../db/pool.js";
import { OrderImportError, parseOrdersCsv } from "./csv-import.js";
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

async function readOrders(path: string) {
  const bytes = await readFile(path);
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
