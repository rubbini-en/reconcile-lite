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

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MAX_CURSOR_LENGTH = 64; // FakePay payment IDs are at most 64 characters.
const WHOLE_NUMBER = /^\d{1,3}$/;

/** Returns the page size, or undefined when invalid. */
function requestedLimit(query: unknown): number | undefined {
  const limit = (query as { limit?: unknown }).limit;
  if (limit === undefined) return DEFAULT_LIMIT;
  if (typeof limit !== "string" || !WHOLE_NUMBER.test(limit)) return undefined;
  const value = Number(limit);
  return value >= 1 && value <= MAX_LIMIT ? value : undefined;
}

/** Returns the cursor, null for the first page, or undefined when invalid. */
function requestedCursor(query: unknown): string | null | undefined {
  const cursor = (query as { cursor?: unknown }).cursor;
  if (cursor === undefined) return null;
  if (typeof cursor !== "string" || cursor.length < 1 || cursor.length > MAX_CURSOR_LENGTH) {
    return undefined;
  }
  return cursor;
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
    const limit = requestedLimit(request.query);
    if (limit === undefined) {
      return reply.code(400).send({
        status: "invalid_request",
        message: `limit must be a whole number from 1 to ${String(MAX_LIMIT)}`,
      });
    }
    const cursor = requestedCursor(request.query);
    if (cursor === undefined) {
      return reply.code(400).send({
        status: "invalid_request",
        message: `cursor must be 1 to ${String(MAX_CURSOR_LENGTH)} characters`,
      });
    }
    const page = cursor === null ? { limit } : { limit, after: cursor };
    const report = await loadExceptionReport(
      day === null ? { pool: options.pool, page } : { pool: options.pool, day, page },
    );
    // The report holds payer names and amounts: never store it in a cache.
    return reply.header("Cache-Control", "no-store").send(report);
  });
}
