import type pg from "pg";
import {
  DEFAULT_MATCHING_CONFIG,
  RECONCILIATION_STATUSES,
  type MatchingConfig,
  type ReconciliationStatus,
} from "../domain/types.js";
import { reconcileBatch, type PaymentDecision } from "./batch.js";
import { loadOrders, loadSettledPayments, replaceResults } from "./repository.js";

/** Session lock shared by every reconcile run (the migration runner uses 726_001). */
export const RECONCILE_LOCK_KEY = 726_002;

export class ReconcileInProgressError extends Error {
  override name = "ReconcileInProgressError";
  constructor() {
    super("A reconcile run is already in progress");
  }
}

export interface RunOptions {
  pool: pg.Pool;
  config?: Readonly<MatchingConfig>;
  now?: () => Date;
}

export interface ReconcileSummary {
  reconciledAt: Date;
  total: number;
  byStatus: Record<ReconciliationStatus, number>;
}

function summarize(decisions: readonly PaymentDecision[], reconciledAt: Date): ReconcileSummary {
  const byStatus = Object.fromEntries(
    RECONCILIATION_STATUSES.map((status) => [status, 0]),
  ) as Record<ReconciliationStatus, number>;
  for (const { decision } of decisions) byStatus[decision.status] += 1;
  return { reconciledAt, total: decisions.length, byStatus };
}

async function reconcileInTransaction(
  client: pg.PoolClient,
  config: Readonly<MatchingConfig>,
  now: () => Date,
): Promise<ReconcileSummary> {
  // One snapshot for every read, so a webhook committing mid-run cannot mix
  // old and new data.
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
  const payments = await loadSettledPayments(client);
  const orders = await loadOrders(client);
  const decisions = reconcileBatch(payments, orders, config);
  const reconciledAt = now();
  await replaceResults(client, decisions, reconciledAt);
  await client.query("COMMIT");
  return summarize(decisions, reconciledAt);
}

/**
 * Reconciles every settled payment and replaces the stored results. Only one
 * run at a time: a run that finds the lock taken fails at once instead of
 * waiting behind a run that may hang. Each run replaces every result, so a
 * refused run loses nothing; the next one reads everything again.
 */
export async function runReconciliation({
  pool,
  config = DEFAULT_MATCHING_CONFIG,
  now = () => new Date(),
}: RunOptions): Promise<ReconcileSummary> {
  const client = await pool.connect();
  let acquired: boolean;
  try {
    const lock = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [RECONCILE_LOCK_KEY],
    );
    acquired = lock.rows[0]?.acquired === true;
  } catch (error) {
    client.release(true);
    throw error;
  }
  if (!acquired) {
    // Nothing was started on this connection, so it can go back to the pool.
    client.release();
    throw new ReconcileInProgressError();
  }
  try {
    const summary = await reconcileInTransaction(client, config, now);
    await client.query("SELECT pg_advisory_unlock($1)", [RECONCILE_LOCK_KEY]);
    client.release();
    return summary;
  } catch (error) {
    // Closing the connection rolls back the transaction and drops the lock.
    client.release(true);
    throw error;
  }
}

/** Plain-text summary for the CLI, one status per line in a fixed order. */
export function formatSummary(summary: ReconcileSummary): string {
  const lines = RECONCILIATION_STATUSES.map(
    (status) => `  ${status.padEnd(16)}${String(summary.byStatus[status])}`,
  );
  const header = `Reconciled ${String(summary.total)} settled payments at ${summary.reconciledAt.toISOString()}`;
  return [header, ...lines].join("\n");
}
