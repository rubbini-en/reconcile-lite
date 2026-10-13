import type pg from "pg";
import { OrderImportError, type NewOrder } from "./csv-import.js";

export interface ImportSummary {
  inserted: number;
  unchanged: number;
}

interface StoredOrderRow {
  customer_name: string;
  amount_minor: string;
  currency: string;
  created_at: Date;
}

function sameOrder(stored: StoredOrderRow, order: NewOrder): boolean {
  return (
    stored.customer_name === order.customerName &&
    stored.amount_minor === String(order.amountMinor) &&
    stored.currency === order.currency &&
    stored.created_at.getTime() === order.createdAt.getTime()
  );
}

/**
 * Imports orders in one transaction. Re-importing an identical order is a
 * no-op, so the same file can be loaded twice; an existing order_ref with
 * different values aborts the whole import instead of overwriting it.
 */
export async function importOrders(
  pool: pg.Pool,
  orders: readonly NewOrder[],
): Promise<ImportSummary> {
  const client = await pool.connect();
  const conflicts: string[] = [];
  let inserted = 0;
  try {
    await client.query("BEGIN");
    for (const order of orders) {
      const result = await client.query(
        `INSERT INTO orders (order_ref, customer_name, amount_minor, currency, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (order_ref) DO NOTHING`,
        [order.orderRef, order.customerName, order.amountMinor, order.currency, order.createdAt],
      );
      if (result.rowCount === 1) {
        inserted += 1;
        continue;
      }
      const existing = await client.query<StoredOrderRow>(
        `SELECT customer_name, amount_minor::text, currency, created_at
         FROM orders WHERE order_ref = $1`,
        [order.orderRef],
      );
      const stored = existing.rows[0];
      if (stored === undefined || !sameOrder(stored, order)) {
        conflicts.push(`order_ref "${order.orderRef}" already exists with different values`);
      }
    }
    if (conflicts.length > 0) throw new OrderImportError(conflicts);
    await client.query("COMMIT");
    client.release();
    return { inserted, unchanged: orders.length - inserted };
  } catch (error) {
    // Closing the connection rolls the transaction back.
    client.release(true);
    throw error;
  }
}
