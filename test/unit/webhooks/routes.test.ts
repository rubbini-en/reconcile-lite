import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { buildApp } from "../../../src/app.js";
import { NOW_SECONDS, settled, sign, TEST_SECRET } from "../../helpers/fakepay.js";

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps.length = 0;
});
function setup() {
  const connect = vi.fn(() => {
    throw new Error("Database must not be reached");
  });
  const app = buildApp({
    pool: { connect } as unknown as pg.Pool,
    config: { databaseUrl: "postgres://unused", fakepayWebhookSecret: TEST_SECRET, port: 3000 },
    now: () => NOW_SECONDS,
    logger: false,
  });
  apps.push(app);
  return { app, connect };
}

describe("webhook HTTP rejection", () => {
  it.each([
    { contentType: "application/xml", payload: "<fictional/>", status: 415 },
    { contentType: "application/json", payload: " ".repeat(1_048_577), status: 413 },
  ])("preserves framework client status $status", async ({ contentType, payload, status }) => {
    const { app, connect } = setup();
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/fakepay",
      headers: { "content-type": contentType },
      payload,
    });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ status: "invalid_request" });
    expect(connect).not.toHaveBeenCalled();
  });
  it.each(["missing", "malformed", "expired", "wrong"])(
    "rejects %s before JSON parsing",
    async (kind) => {
      const { app, connect } = setup();
      const raw = Buffer.from("{");
      const signatures: Record<string, string | undefined> = {
        missing: undefined,
        malformed: "invalid",
        expired: sign(raw, NOW_SECONDS - 301),
        wrong: sign(raw, NOW_SECONDS, "fictional-wrong-secret"),
      };
      const signature = signatures[kind];
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/fakepay",
        headers: {
          "content-type": "application/json",
          ...(signature ? { "fakepay-signature": signature } : {}),
        },
        payload: raw,
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ status: "unauthorized" });
      expect(connect).not.toHaveBeenCalled();
    },
  );
  it.each([Buffer.from("{"), Buffer.from([0xff]), Buffer.alloc(0)])(
    "rejects signed invalid JSON/encoding",
    async (raw) => {
      const { app, connect } = setup();
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/fakepay",
        headers: { "content-type": "application/json", "fakepay-signature": sign(raw) },
        payload: raw,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ status: "invalid_json" });
      expect(connect).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["NUL", "\u0000"],
    ["lone high surrogate", "\ud800"],
    ["lone low surrogate", "\udc00"],
  ])("rejects %s in values and object keys before database access", async (_label, poison) => {
    const { app, connect } = setup();
    const event = settled();
    for (const payload of [
      { ...event, data: { ...event.data, customer_name: poison } },
      { ...event, ignored: { nested: [null, { value: poison }] } },
      { ...event, ignored: [{ [poison]: "ignored" }] },
      { ...event, [poison]: true },
    ]) {
      const raw = Buffer.from(JSON.stringify(payload));
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/fakepay",
        headers: { "content-type": "application/json", "fakepay-signature": sign(raw) },
        payload: raw,
      });
      expect(response.statusCode).toBe(400);
      expect(connect).not.toHaveBeenCalled();
    }
  });
  it("accepts well-formed surrogate pairs in ignored fields", async () => {
    const { app, connect } = setup();
    const raw = Buffer.from(JSON.stringify({ ...settled(), ignored: "😀" }));
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/fakepay",
      headers: { "content-type": "application/json", "fakepay-signature": sign(raw) },
      payload: raw,
    });
    expect(response.statusCode).toBe(500);
    expect(connect).toHaveBeenCalledTimes(1);
  });
  it("logs error context without request bodies, headers, signatures or secrets", async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const failure = Object.assign(new Error("Database connection unavailable"), {
      code: "ECONNREFUSED",
    });
    const app = buildApp({
      pool: {
        connect: vi.fn(() => {
          throw failure;
        }),
      } as unknown as pg.Pool,
      config: { databaseUrl: "postgres://unused", fakepayWebhookSecret: TEST_SECRET, port: 3000 },
      now: () => NOW_SECONDS,
      logger: { stream },
    });
    apps.push(app);
    // Exercise redaction even when a future hook explicitly logs request fields.
    app.addHook("preHandler", (request, _reply, done) => {
      request.log.info({ body: request.body, headers: request.headers, req: request });
      done();
    });
    const event = settled();
    const raw = Buffer.from(JSON.stringify({ ...event, ignored: "private-body-marker" }));
    const signature = sign(raw);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/webhooks/fakepay",
          headers: {
            "content-type": "application/json",
            "fakepay-signature": signature,
            "x-private": "private-header-marker",
          },
          payload: raw,
        })
      ).statusCode,
    ).toBe(500);
    const logs = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const error = logs.find((entry) => entry.level === 50);
    expect(error).toBeDefined();
    expect(JSON.stringify(error)).toContain(failure.message);
    expect(JSON.stringify(error)).toContain(failure.code);
    expect(JSON.stringify(error)).toContain(event.id);
    expect(error?.requestId).toEqual(expect.any(String));
    const serialized = lines.join("");
    for (const privateValue of [
      signature,
      TEST_SECRET,
      "private-body-marker",
      "private-header-marker",
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(serialized).not.toContain('"type":"Buffer"');
    expect(serialized).not.toContain('"fakepay-signature"');
  });
  it("returns Zod paths without payload values", async () => {
    const { app, connect } = setup();
    const event = settled();
    const raw = Buffer.from(JSON.stringify({ ...event, data: { ...event.data, amount_minor: 0 } }));
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/fakepay",
      headers: { "content-type": "application/json", "fakepay-signature": sign(raw) },
      payload: raw,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      status: "invalid_schema",
      issues: [{ path: ["data", "amount_minor"] }],
    });
    expect(connect).not.toHaveBeenCalled();
  });
  it("keeps the raw parser scoped to the webhook plugin", async () => {
    const { app } = setup();
    app.post("/ordinary", (request) => ({ body: request.body }));
    const response = await app.inject({
      method: "POST",
      url: "/ordinary",
      payload: { fictional: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ body: { fictional: true } });
  });
  it("returns a generic retryable error when the database is unavailable", async () => {
    const { app, connect } = setup();
    const raw = Buffer.from(JSON.stringify(settled()));
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/fakepay",
      headers: { "content-type": "application/json", "fakepay-signature": sign(raw) },
      payload: raw,
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ status: "internal_error" });
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
