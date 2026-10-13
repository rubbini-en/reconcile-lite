import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../../src/app.js";
import { createTestPool, resetDatabase } from "../../helpers/database.js";
import { NOW_SECONDS, refunded, settled, sign, TEST_SECRET } from "../../helpers/fakepay.js";

type TestEvent = ReturnType<typeof settled> | ReturnType<typeof refunded>;
let pool: pg.Pool;
let app: FastifyInstance;

beforeAll(() => {
  pool = createTestPool();
  app = buildApp({
    pool,
    config: { databaseUrl: "postgres://unused", fakepayWebhookSecret: TEST_SECRET, port: 3000 },
    now: () => NOW_SECONDS,
    logger: false,
  });
});
beforeEach(async () => {
  await resetDatabase(pool);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

function deliver(event: TestEvent, timestamp = NOW_SECONDS) {
  const rawBody = Buffer.from(JSON.stringify(event));
  return deliverRaw(rawBody, sign(rawBody, timestamp));
}
function deliverRaw(rawBody: Buffer, signature?: string) {
  return app.inject({
    method: "POST",
    url: "/webhooks/fakepay",
    headers: {
      "content-type": "application/json",
      ...(signature === undefined ? {} : { "fakepay-signature": signature }),
    },
    payload: rawBody,
  });
}
async function snapshot() {
  return {
    events: (await pool.query("SELECT * FROM webhook_events ORDER BY provider_event_id"))
      .rows as unknown[],
    payments: (await pool.query("SELECT * FROM payments ORDER BY provider_payment_id"))
      .rows as unknown[],
  };
}
async function expectEvents(events: TestEvent[]) {
  const stored = await pool.query("SELECT * FROM webhook_events ORDER BY provider_event_id");
  expect(stored.rows).toEqual(
    [...events]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((event) => {
        const raw = JSON.stringify(event);
        return {
          id: expect.stringMatching(/^\d+$/) as unknown,
          provider_event_id: event.id,
          event_type: event.type,
          provider_payment_id: event.data.payment_id,
          occurred_at: new Date(event.occurred_at),
          raw_body: raw,
          body_sha256: createHash("sha256").update(raw).digest("hex"),
          payload: event,
          received_at: expect.any(Date) as unknown,
        };
      }),
  );
}
async function expectPayment(
  event: ReturnType<typeof settled> | null,
  refundedMinor: string,
  anomalies: string[] = [],
) {
  expect((await pool.query("SELECT * FROM payments")).rows).toEqual([
    {
      id: expect.stringMatching(/^\d+$/) as unknown,
      provider_payment_id: event?.data.payment_id ?? "pay_fictional",
      amount_minor: event ? String(event.data.amount_minor) : null,
      currency: event?.data.currency ?? null,
      reference: event?.data.reference ?? null,
      customer_name: event?.data.customer_name ?? null,
      settled_at: event ? new Date(event.occurred_at) : null,
      refunded_minor: refundedMinor,
      anomalies,
      updated_at: expect.any(Date) as unknown,
    },
  ]);
}
function expectResponse(
  response: { statusCode: number; json: () => unknown },
  statusCode: number,
  status: string,
) {
  expect(response.statusCode).toBe(statusCode);
  expect(response.json()).toEqual({ status });
}

describe("FakePay ingestion", () => {
  it("stores once and leaves every row unchanged on duplicate and re-signed retry", async () => {
    const event = settled();
    expectResponse(await deliver(event), 200, "processed");
    await expectEvents([event]);
    await expectPayment(event, "0");
    const original = await snapshot();
    expectResponse(await deliver(event), 200, "duplicate");
    expect(await snapshot()).toEqual(original);
    expectResponse(await deliver(event, NOW_SECONDS + 120), 200, "duplicate");
    expect(await snapshot()).toEqual(original);
  });
  it("rejects a changed body with the same event ID, even on another payment", async () => {
    const event = settled();
    expectResponse(await deliver(event), 200, "processed");
    const original = await snapshot();
    expectResponse(await deliver(settled({ amount: 12 })), 409, "conflict");
    expect(await snapshot()).toEqual(original);
    expectResponse(await deliver(settled({ paymentId: "pay_other" })), 409, "conflict");
    expect(await snapshot()).toEqual(original);
  });
  it("serializes ten identical deliveries", async () => {
    const event = settled();
    const responses = await Promise.all(Array.from({ length: 10 }, () => deliver(event)));
    expect(responses.map((response) => response.statusCode)).toEqual(Array<number>(10).fill(200));
    expect(responses.map((response) => response.json<unknown>())).toEqual(
      expect.arrayContaining([{ status: "processed" }, { status: "duplicate" }]),
    );
    expect(responses.filter((response) => response.body === '{"status":"processed"}')).toHaveLength(
      1,
    );
    expect(responses.filter((response) => response.body === '{"status":"duplicate"}')).toHaveLength(
      9,
    );
    await expectEvents([event]);
    await expectPayment(event, "0");
  });
  it("creates an unsettled payment then rebuilds after settlement", async () => {
    const refund = refunded();
    const settlement = settled();
    expectResponse(await deliver(refund), 200, "processed");
    await expectEvents([refund]);
    await expectPayment(null, "50000");
    expectResponse(await deliver(settlement), 200, "processed");
    await expectEvents([refund, settlement]);
    await expectPayment(settlement, "50000");
  });
  it("serializes concurrent settlement and refund", async () => {
    const events = [settled(), refunded()];
    for (const response of await Promise.all(events.map((event) => deliver(event))))
      expectResponse(response, 200, "processed");
    await expectEvents(events);
    await expectPayment(settled(), "50000");
  });
  it("blocks settlement and refund writes until the per-payment advisory lock is released", async () => {
    const blocker = await pool.connect();
    const settlement = settled();
    const refund = refunded();
    let deliveries: Promise<Awaited<ReturnType<typeof deliver>>[]> | undefined;
    try {
      await blocker.query("BEGIN");
      const owner = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        settlement.data.payment_id,
      ]);
      deliveries = Promise.all([deliver(settlement), deliver(refund)]);
      await expect
        .poll(
          async () => {
            const waiting = await pool.query<{ count: number }>(
              "SELECT count(*)::integer AS count FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND $1::integer = ANY(pg_blocking_pids(pid))",
              [owner.rows[0]?.pid],
            );
            return waiting.rows[0]?.count;
          },
          { timeout: 3000 },
        )
        .toBe(2);
      expect((await pool.query("SELECT * FROM payments")).rows).toEqual([]);
      await blocker.query("COMMIT");
      for (const response of await deliveries) expectResponse(response, 200, "processed");
      await expectEvents([settlement, refund]);
      await expectPayment(settlement, "50000");
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await deliveries;
    }
  });
  it("rejects poison strings in ignored nested fields without storing anything", async () => {
    for (const poison of ["\u0000", "\ud800", "\udc00"]) {
      for (const ignored of [{ nested: [poison] }, { [poison]: "value" }]) {
        const raw = Buffer.from(JSON.stringify({ ...settled(), ignored }));
        expect((await deliverRaw(raw, sign(raw))).statusCode).toBe(400);
        expect(await snapshot()).toEqual({ events: [], payments: [] });
      }
    }
  });
  it.each(["missing", "null"])("stores %s reference and customer name as NULL", async (kind) => {
    const event = settled();
    const { reference: _reference, customer_name: _customerName, ...fields } = event.data;
    const data = kind === "missing" ? fields : { ...fields, reference: null, customer_name: null };
    const raw = Buffer.from(JSON.stringify({ ...event, data }));
    expectResponse(await deliverRaw(raw, sign(raw)), 200, "processed");
    await expectPayment(
      { ...event, data: { ...fields, reference: null, customer_name: null } },
      "0",
    );
  });
  it.each(["PYG", "USD"] as const)("stores exact %s amounts end to end", async (currency) => {
    const settlement = settled({ currency, amount: currency === "PYG" ? 150000 : 1234 });
    const refund = refunded({ currency, amount: currency === "PYG" ? 50000 : 234 });
    expectResponse(await deliver(settlement), 200, "processed");
    expectResponse(await deliver(refund), 200, "processed");
    await expectEvents([settlement, refund]);
    await expectPayment(settlement, String(refund.data.amount_minor));
  });
  it("persists every anomaly and a total beyond safe number range", async () => {
    const settlement = settled({ amount: Number.MAX_SAFE_INTEGER });
    const events = [
      settlement,
      settled({ id: "evt_zsettlement" }),
      refunded({ amount: Number.MAX_SAFE_INTEGER }),
      refunded({ id: "evt_zrefund", amount: 1 }),
      refunded({ id: "evt_b", refundId: "rf_b", amount: 2 }),
      refunded({ id: "evt_c", refundId: "rf_c", currency: "USD" }),
    ];
    for (const event of events) expectResponse(await deliver(event), 200, "processed");
    await expectEvents(events);
    await expectPayment(settlement, "9007199254740993", [
      "multiple_settlements",
      "conflicting_refund",
      "refund_currency_mismatch",
      "refunds_exceed_amount",
    ]);
  });
  it("uses provider IDs rather than arrival IDs for timestamp ties", async () => {
    const later = settled({ id: "evt_z", amount: 200 });
    const first = settled({ id: "evt_a", amount: 100 });
    expectResponse(await deliver(later), 200, "processed");
    expectResponse(await deliver(first), 200, "processed");
    await expectEvents([later, first]);
    await expectPayment(first, "0", ["multiple_settlements"]);
  });
  it.each(["missing", "malformed", "wrong", "expired", "future", "modified"])(
    "rejects %s signature without storing anything",
    async (failure) => {
      const raw = Buffer.from(JSON.stringify(settled()));
      const signature =
        failure === "missing"
          ? undefined
          : failure === "malformed"
            ? "invalid"
            : failure === "wrong"
              ? sign(raw, NOW_SECONDS, "fictional-wrong-secret")
              : failure === "expired"
                ? sign(raw, NOW_SECONDS - 301)
                : failure === "future"
                  ? sign(raw, NOW_SECONDS + 301)
                  : sign(Buffer.concat([raw, Buffer.from(" ")]));
      expectResponse(await deliverRaw(raw, signature), 401, "unauthorized");
      expect(await snapshot()).toEqual({ events: [], payments: [] });
    },
  );
  it("checks signatures before invalid JSON", async () => {
    expectResponse(await deliverRaw(Buffer.from("{")), 401, "unauthorized");
    expect(await snapshot()).toEqual({ events: [], payments: [] });
  });
  it("rejects signed invalid JSON without leaking content", async () => {
    const raw = Buffer.from('{"private":"fictional-sensitive-value"');
    expectResponse(await deliverRaw(raw, sign(raw)), 400, "invalid_json");
    expect(await snapshot()).toEqual({ events: [], payments: [] });
  });
  it("returns only issue paths for schema errors", async () => {
    const event = settled();
    const raw = Buffer.from(
      JSON.stringify({ ...event, data: { ...event.data, amount_minor: 1.5 } }),
    );
    const response = await deliverRaw(raw, sign(raw));
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      status: "invalid_schema",
      issues: [{ path: ["data", "amount_minor"] }],
    });
    expect(await snapshot()).toEqual({ events: [], payments: [] });
  });
  it("preserves whitespace, unicode, and ignored fields in raw storage", async () => {
    const event = { ...settled(), fictional_note: "Ficción" };
    const raw = Buffer.from(JSON.stringify(event, null, 2) + "\n");
    expectResponse(await deliverRaw(raw, sign(raw)), 200, "processed");
    expect(
      (await pool.query("SELECT raw_body, body_sha256, payload FROM webhook_events")).rows,
    ).toEqual([
      {
        raw_body: raw.toString("utf8"),
        body_sha256: createHash("sha256").update(raw).digest("hex"),
        payload: event,
      },
    ]);
    await expectPayment(settled(), "0");
  });
  it("rejects invalid UTF-8 rather than altering signed bytes", async () => {
    const raw = Buffer.concat([Buffer.from('{"note":"'), Buffer.from([0xff]), Buffer.from('"}')]);
    expectResponse(await deliverRaw(raw, sign(raw)), 400, "invalid_json");
    expect(await snapshot()).toEqual({ events: [], payments: [] });
  });
});
