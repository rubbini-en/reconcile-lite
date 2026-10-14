import { createPool } from "../db/pool.js";
import { formatSummary, ReconcileInProgressError, runReconciliation } from "./run.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const pool = createPool(databaseUrl);
try {
  console.log(formatSummary(await runReconciliation({ pool })));
} catch (error) {
  if (!(error instanceof ReconcileInProgressError)) throw error;
  console.error(`${error.message}; try again when it finishes.`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
