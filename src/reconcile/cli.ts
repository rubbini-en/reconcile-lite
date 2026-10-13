import { createPool } from "../db/pool.js";
import { formatSummary, runReconciliation } from "./run.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const pool = createPool(databaseUrl);
try {
  console.log(formatSummary(await runReconciliation({ pool })));
} finally {
  await pool.end();
}
