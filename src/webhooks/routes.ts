import { isUtf8 } from "node:buffer";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { AppConfig } from "../config.js";
import { ingestWebhook } from "./ingest.js";
import { eventSchema } from "./schema.js";
import { verifySignature } from "./signature.js";

/** Fastify's default, pinned here so a framework change cannot silently move it. */
const WEBHOOK_BODY_LIMIT_BYTES = 1_048_576;

export interface WebhookOptions {
  pool: pg.Pool;
  config: AppConfig;
  /** Unix seconds for the delivery signature tolerance. */
  now: () => number;
}

export function webhookRoutes(app: FastifyInstance, options: WebhookOptions): void {
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer", bodyLimit: WEBHOOK_BODY_LIMIT_BYTES },
    (_request, body, done) => {
      done(null, body);
    },
  );
  app.post<{ Body: Buffer }>("/webhooks/fakepay", async (request, reply) => {
    const header = request.headers["fakepay-signature"];
    const verified = verifySignature({
      rawBody: request.body,
      header: typeof header === "string" ? header : undefined,
      secret: options.config.fakepayWebhookSecret,
      nowSeconds: options.now(),
    });
    if (!verified.ok) return reply.code(401).send({ status: "unauthorized" });
    if (!isUtf8(request.body)) return reply.code(400).send({ status: "invalid_json" });
    let payload: unknown;
    try {
      payload = JSON.parse(request.body.toString("utf8")) as unknown;
    } catch {
      return reply.code(400).send({ status: "invalid_json" });
    }
    if (containsUnstorableText(payload)) return reply.code(400).send({ status: "invalid_json" });
    const parsed = eventSchema.safeParse(payload);
    if (!parsed.success) {
      return reply.code(400).send({
        status: "invalid_schema",
        issues: parsed.error.issues.map((issue) => ({ path: issue.path })),
      });
    }
    request.log = request.log.child({ eventId: parsed.data.id });
    const status = await ingestWebhook({
      pool: options.pool,
      event: parsed.data,
      rawBody: request.body,
      payload,
    });
    return reply.code(status === "conflict" ? 409 : 200).send({ status });
  });
}

/**
 * Postgres jsonb rejects NUL and lone surrogates, so they would fail the insert
 * with a 500 and FakePay would retry forever. Walks iteratively because a 1 MB
 * body can nest deeper than the call stack allows.
 */
function containsUnstorableText(payload: unknown): boolean {
  const pending: unknown[] = [payload];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      if (isUnstorable(value)) return true;
    } else if (Array.isArray(value)) {
      pending.push(...(value as unknown[]));
    } else if (typeof value === "object" && value !== null) {
      for (const [key, nested] of Object.entries(value)) {
        if (isUnstorable(key)) return true;
        pending.push(nested);
      }
    }
  }
  return false;
}

// With the `u` flag a valid surrogate pair is one code point, so only lone
// surrogates (text that is not well-formed UTF-16) match.
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

function isUnstorable(text: string): boolean {
  return text.includes("\u0000") || LONE_SURROGATE.test(text);
}
