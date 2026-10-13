import Fastify, { type FastifyError, type FastifyServerOptions } from "fastify";
import { webhookRoutes, type WebhookOptions } from "./webhooks/routes.js";

type LoggerOption = Exclude<FastifyServerOptions["logger"], undefined>;

export interface AppOptions extends Omit<WebhookOptions, "now"> {
  now?: () => number;
  /** Defaults to on; tests pass `false`. Redaction is always applied. */
  logger?: LoggerOption;
}

// Webhook bodies and headers carry customer data and the signature.
const REDACTED_PATHS = [
  "body",
  "headers",
  "req.body",
  "req.headers",
  "request.body",
  "request.headers",
];

function loggerOptions(logger: LoggerOption = true): LoggerOption {
  if (logger === false) return false;
  const base = typeof logger === "object" ? logger : {};
  return { ...base, redact: REDACTED_PATHS };
}

export function buildApp({ logger, ...options }: AppOptions) {
  const app = Fastify({ logger: loggerOptions(logger) });
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    if (error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ status: "invalid_request" });
    }
    request.log.error(
      {
        err: { message: error.message, code: error.code, stack: error.stack },
        requestId: request.id,
      },
      "Request failed",
    );
    return reply.code(500).send({ status: "internal_error" });
  });
  app.register((scope, _options, done) => {
    webhookRoutes(scope, { ...options, now: options.now ?? (() => Math.floor(Date.now() / 1000)) });
    done();
  });
  return app;
}
