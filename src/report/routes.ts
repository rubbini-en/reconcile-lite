import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { AppConfig } from "../config.js";
import { parseReportDay, ReportError, type ReportDay } from "./exceptions.js";
import { loadExceptionReport } from "./repository.js";

export interface ExceptionsOptions {
  pool: pg.Pool;
  config: AppConfig;
}

const BEARER = /^bearer (.+)$/i;

/** Hashing first gives equal-length buffers, so the compare leaks neither content nor length. */
function hasValidToken(authorization: string | undefined, expected: string): boolean {
  const supplied = authorization === undefined ? undefined : BEARER.exec(authorization)?.[1];
  if (supplied === undefined) return false;
  const digest = (text: string) => createHash("sha256").update(text).digest();
  return timingSafeEqual(digest(supplied), digest(expected));
}

/** Returns the requested day, null for all days, or undefined when invalid. */
function requestedDay(query: unknown): ReportDay | null | undefined {
  const day = (query as { day?: unknown }).day;
  if (day === undefined) return null;
  if (typeof day !== "string") return undefined;
  try {
    return parseReportDay(day);
  } catch (error) {
    if (error instanceof ReportError) return undefined;
    throw error;
  }
}

export function exceptionsRoutes(app: FastifyInstance, options: ExceptionsOptions): void {
  app.get("/exceptions", async (request, reply) => {
    if (!hasValidToken(request.headers.authorization, options.config.reportApiToken)) {
      return reply.code(401).header("WWW-Authenticate", "Bearer").send({ status: "unauthorized" });
    }
    const day = requestedDay(request.query);
    if (day === undefined) {
      return reply.code(400).send({
        status: "invalid_request",
        message: "day must be a calendar date as YYYY-MM-DD",
      });
    }
    const report = await loadExceptionReport(
      day === null ? { pool: options.pool } : { pool: options.pool, day },
    );
    // The report holds payer names and amounts: never store it in a cache.
    return reply.header("Cache-Control", "no-store").send(report);
  });
}
