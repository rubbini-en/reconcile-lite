import { createHash } from "node:crypto";
import type pg from "pg";
import { foldPaymentEvents } from "../payments/state.js";
import { eventSchema, type FakePayEvent } from "./schema.js";

export async function ingestWebhook({
  pool,
  event,
  rawBody,
  payload,
}: {
  pool: pg.Pool;
  event: FakePayEvent;
  rawBody: Buffer;
  payload: unknown;
}): Promise<"processed" | "duplicate" | "conflict"> {
  const bodyHash = createHash("sha256").update(rawBody).digest("hex");
  const client = await pool.connect();
  let discardClient = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      event.data.payment_id,
    ]);
    const inserted = await client.query(
      `INSERT INTO webhook_events
        (provider_event_id, event_type, provider_payment_id, occurred_at, raw_body, body_sha256, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (provider_event_id) DO NOTHING RETURNING provider_event_id`,
      [
        event.id,
        event.type,
        event.data.payment_id,
        event.occurred_at,
        rawBody.toString("utf8"),
        bodyHash,
        JSON.stringify(payload),
      ],
    );
    if (inserted.rowCount === 0) {
      const existing = await client.query<{ body_sha256: string }>(
        "SELECT body_sha256 FROM webhook_events WHERE provider_event_id = $1",
        [event.id],
      );
      const stored = existing.rows[0];
      if (stored === undefined) throw new Error("Conflicting webhook event was not found");
      await client.query("COMMIT");
      return stored.body_sha256 === bodyHash ? "duplicate" : "conflict";
    }
    const storedEvents = await client.query<{ payload: unknown }>(
      "SELECT payload FROM webhook_events WHERE provider_payment_id = $1",
      [event.data.payment_id],
    );
    // Stored payloads are re-validated with the current schema. Before tightening
    // eventSchema, check existing rows: one that no longer parses makes every
    // later event for that payment fail.
    const state = foldPaymentEvents(storedEvents.rows.map((row) => eventSchema.parse(row.payload)));
    await client.query(
      `INSERT INTO payments
        (provider_payment_id, amount_minor, currency, reference, customer_name, settled_at, refunded_minor, anomalies)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (provider_payment_id) DO UPDATE SET
         amount_minor = EXCLUDED.amount_minor,
         currency = EXCLUDED.currency,
         reference = EXCLUDED.reference,
         customer_name = EXCLUDED.customer_name,
         settled_at = EXCLUDED.settled_at,
         refunded_minor = EXCLUDED.refunded_minor,
         anomalies = EXCLUDED.anomalies,
         updated_at = now()`,
      [
        event.data.payment_id,
        state.amountMinor,
        state.currency,
        state.reference,
        state.customerName,
        state.settledAt,
        state.refundedMinor.toString(),
        state.anomalies,
      ],
    );
    await client.query("COMMIT");
    return "processed";
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      discardClient = true;
    }
    throw error;
  } finally {
    client.release(discardClient);
  }
}
