import { describe, expect, it, vi } from "vitest";
import { formatDecimalAmount } from "../../../src/money.js";
import { parseOrdersCsv } from "../../../src/orders/csv-import.js";
import { deliverEvents } from "../../../src/simulator/deliver.js";
import { assertLoopbackUrl, SimulatorError } from "../../../src/simulator/loopback.js";
import { createRandom, shuffle } from "../../../src/simulator/random.js";
import { buildScenario, ordersCsv } from "../../../src/simulator/scenario.js";
import { eventSchema } from "../../../src/webhooks/schema.js";
import { signatureHeader, verifySignature } from "../../../src/webhooks/signature.js";
import { NOW_SECONDS, sign, TEST_SECRET } from "../../helpers/fakepay.js";

describe("signatureHeader", () => {
  it("matches the independent test signer and verifies", () => {
    const body = Buffer.from('{"id":"evt_sim_x"}');
    const header = signatureHeader(body, TEST_SECRET, NOW_SECONDS);
    expect(header).toBe(sign(body, NOW_SECONDS, TEST_SECRET));
    expect(
      verifySignature({ rawBody: body, header, secret: TEST_SECRET, nowSeconds: NOW_SECONDS }),
    ).toEqual({ ok: true });
  });
});

describe("formatDecimalAmount", () => {
  it.each([
    [150000, "PYG", "150000"],
    [1234, "USD", "12.34"],
    [5, "USD", "0.05"],
  ] as const)("formats %d %s as %s", (minor, currency, text) => {
    expect(formatDecimalAmount(minor, currency)).toBe(text);
  });
});

describe("assertLoopbackUrl", () => {
  it.each([
    "http://127.0.0.1:3000/webhooks/fakepay",
    "http://localhost:3000/webhooks/fakepay",
    "http://[::1]:3000/webhooks/fakepay",
  ])("accepts %s", (url) => {
    expect(() => assertLoopbackUrl(url)).not.toThrow();
  });

  it.each([
    "https://example.com/webhooks/fakepay",
    "http://10.0.0.5:3000/webhooks/fakepay",
    "http://127.0.0.1.example.com/webhooks/fakepay",
    "http://localhost.example.com/webhooks/fakepay",
    "ftp://127.0.0.1/webhooks/fakepay",
    "not a url",
  ])("rejects %s", (url) => {
    expect(() => assertLoopbackUrl(url)).toThrow(SimulatorError);
  });
});

describe("shuffle", () => {
  const items = Array.from({ length: 20 }, (_, index) => index);

  it("is a permutation that depends only on the seed", () => {
    const first = shuffle(items, createRandom(42));
    expect(shuffle(items, createRandom(42))).toEqual(first);
    expect([...first].sort((a, b) => a - b)).toEqual(items);
    expect(first).not.toEqual(items);
    expect(shuffle(items, createRandom(7))).not.toEqual(first);
  });
});

describe("buildScenario", () => {
  const scenario = buildScenario();

  it("produces contract-valid events with unique IDs", () => {
    for (const event of scenario.events) expect(eventSchema.parse(event)).toEqual(event);
    const ids = scenario.events.map((event) => event.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("writes an orders CSV that the importer reads back unchanged", () => {
    expect(parseOrdersCsv(ordersCsv(scenario.orders))).toEqual(scenario.orders);
  });

  it("states an expected outcome for every payment it sends", () => {
    const paymentIds = new Set(scenario.events.map((event) => event.data.payment_id));
    expect(new Set(Object.keys(scenario.expected))).toEqual(paymentIds);
  });

  it("covers every reconciliation outcome, including partial refunds", () => {
    const outcomes = Object.values(scenario.expected);
    expect(new Set(outcomes.map((outcome) => outcome.status))).toEqual(
      new Set([
        "matched",
        "ambiguous",
        "unmatched",
        "amount_mismatch",
        "duplicate",
        "refunded",
        "awaiting_settlement",
      ]),
    );
    expect(outcomes.some((outcome) => outcome.partialRefund)).toBe(true);
  });
});

function response(status: number, body: object = { status: "processed" }) {
  return new Response(JSON.stringify(body), { status });
}

describe("deliverEvents", () => {
  const events = buildScenario().events.slice(0, 3);
  const base = {
    url: "http://127.0.0.1:3000/webhooks/fakepay",
    secret: TEST_SECRET,
    seed: 1,
    redeliveries: 0,
    nowSeconds: () => NOW_SECONDS,
    sleep: () => Promise.resolve(),
  };

  it("sends each event once with a valid signature over the exact body", async () => {
    const fetch = vi.fn((_url: string, _init: RequestInit) => Promise.resolve(response(200)));
    const summary = await deliverEvents(events, { ...base, fetch });
    expect(summary).toEqual({
      deliveries: 3,
      attempts: 3,
      byStatus: { processed: 3 },
      failedEventIds: [],
    });
    for (const [url, init] of fetch.mock.calls) {
      expect(url).toBe(base.url);
      const body = Buffer.from(init.body as string);
      const header = (init.headers as Record<string, string>)["fakepay-signature"];
      expect(
        verifySignature({ rawBody: body, header, secret: TEST_SECRET, nowSeconds: NOW_SECONDS }),
      ).toEqual({ ok: true });
    }
  });

  it("redelivers some events with byte-identical bodies", async () => {
    const fetch = vi.fn((_url: string, _init: RequestInit) => Promise.resolve(response(200)));
    const summary = await deliverEvents(events, { ...base, redeliveries: 2, fetch });
    expect(summary.deliveries).toBe(5);
    const bodies = fetch.mock.calls.map(([, init]) => init.body as string);
    expect(new Set(bodies).size).toBe(3);
  });

  it("retries a non-2xx response, signing each attempt again", async () => {
    const times = [NOW_SECONDS, NOW_SECONDS + 30];
    const fetch = vi
      .fn((_url: string, _init: RequestInit) => Promise.resolve(response(200)))
      .mockResolvedValueOnce(response(500, { status: "internal_error" }));
    const summary = await deliverEvents(events.slice(0, 1), {
      ...base,
      nowSeconds: () => times.shift() ?? NOW_SECONDS,
      fetch,
    });
    expect(summary).toEqual({
      deliveries: 1,
      attempts: 2,
      byStatus: { processed: 1 },
      failedEventIds: [],
    });
    const headers = fetch.mock.calls.map(
      ([, init]) => (init.headers as Record<string, string>)["fakepay-signature"],
    );
    expect(headers[0]).toMatch(new RegExp(`^t=${String(NOW_SECONDS)},`));
    expect(headers[1]).toMatch(new RegExp(`^t=${String(NOW_SECONDS + 30)},`));
  });

  it("reports an event as failed after the last attempt", async () => {
    const fetch = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(response(409, { status: "conflict" })),
    );
    const summary = await deliverEvents(events.slice(0, 1), { ...base, maxAttempts: 3, fetch });
    expect(summary).toEqual({
      deliveries: 1,
      attempts: 3,
      byStatus: { "http 409": 1 },
      failedEventIds: [events[0]?.id],
    });
  });

  it("retries a network error like any failed attempt", async () => {
    const fetch = vi
      .fn((_url: string, _init: RequestInit) => Promise.resolve(response(200)))
      .mockRejectedValueOnce(new TypeError("fetch failed"));
    const summary = await deliverEvents(events.slice(0, 1), { ...base, fetch });
    expect(summary).toEqual({
      deliveries: 1,
      attempts: 2,
      byStatus: { processed: 1 },
      failedEventIds: [],
    });
  });

  it("reports a network error that outlasts every attempt and keeps going", async () => {
    const fetch = vi.fn((_url: string, _init: RequestInit) =>
      Promise.reject(new TypeError("fetch failed")),
    );
    const summary = await deliverEvents(events.slice(0, 2), { ...base, maxAttempts: 2, fetch });
    expect({ ...summary, failedEventIds: [...summary.failedEventIds].sort() }).toEqual({
      deliveries: 2,
      attempts: 4,
      byStatus: { "network error": 2 },
      failedEventIds: events
        .slice(0, 2)
        .map((event) => event.id)
        .sort(),
    });
  });

  it("refuses a non-loopback URL before sending anything", async () => {
    const fetch = vi.fn();
    await expect(
      deliverEvents(events, { ...base, url: "https://example.com/hook", fetch }),
    ).rejects.toThrow(SimulatorError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
