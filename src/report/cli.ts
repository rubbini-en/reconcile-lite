import { parseArgs } from "node:util";
import { createPool } from "../db/pool.js";
import { parseReportDay, ReportError, type ReportDay } from "./exceptions.js";
import { renderCsv, renderMarkdown } from "./render.js";
import { loadExceptionReport } from "./repository.js";

const USAGE = "Usage: npm run report -- [--format md|csv] [--day YYYY-MM-DD]";
const RENDERERS = { md: renderMarkdown, csv: renderCsv };

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function readArguments(): { format: keyof typeof RENDERERS; day: ReportDay | undefined } {
  let values;
  try {
    ({ values } = parseArgs({
      options: { format: { type: "string", default: "md" }, day: { type: "string" } },
      strict: true,
    }));
  } catch {
    return fail(USAGE);
  }
  const { format, day } = values;
  if (format !== "md" && format !== "csv") return fail(USAGE);
  try {
    return { format, day: day === undefined ? undefined : parseReportDay(day) };
  } catch (error) {
    if (error instanceof ReportError) return fail(error.message);
    throw error;
  }
}

const { format, day } = readArguments();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) fail("DATABASE_URL is not set");

const pool = createPool(databaseUrl);
try {
  const report = await loadExceptionReport(day === undefined ? { pool } : { pool, day });
  process.stdout.write(RENDERERS[format](report));
} finally {
  await pool.end();
}
