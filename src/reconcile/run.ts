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
const RECONCILE_LOCK_KEY = 726_002;

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
 * Reconciles every settled payment and replaces the stored results. Runs wait
 * for each other: the lock is taken before the transaction starts, so each run
 * reads the data the previous one committed.
 */
export async function runReconciliation({
  pool,
  config = DEFAULT_MATCHING_CONFIG,
  now = () => new Date(),
}: RunOptions): Promise<ReconcileSummary> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [RECONCILE_LOCK_KEY]);
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
