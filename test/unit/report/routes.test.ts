import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { buildApp } from "../../../src/app.js";
import { TEST_CONFIG, TEST_REPORT_TOKEN } from "../../helpers/fakepay.js";

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
    config: TEST_CONFIG,
    logger: false,
  });
  apps.push(app);
  return { app, connect };
}

describe("GET /exceptions access", () => {
  it.each([
    ["no Authorization header", undefined],
    ["a wrong token", "Bearer fictional-wrong-token-000000000000000"],
    ["a wrong token of a different length", "Bearer x"],
    ["the right token with another scheme", `Basic ${TEST_REPORT_TOKEN}`],
    ["the right token without a scheme", TEST_REPORT_TOKEN],
    ["an empty bearer token", "Bearer "],
  ])("returns 401 for %s without touching the database", async (_label, authorization) => {
    const { app, connect } = setup();
    const response = await app.inject({
      method: "GET",
      url: "/exceptions",
      headers: authorization === undefined ? {} : { authorization },
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toBe("Bearer");
    expect(response.json()).toEqual({ status: "unauthorized" });
    expect(connect).not.toHaveBeenCalled();
  });

  it.each([
    ["an impossible date", "?day=2026-02-30"],
    ["a repeated day", "?day=2026-10-10&day=2026-10-11"],
  ])("returns 400 for %s", async (_label, query) => {
    const { app, connect } = setup();
    const response = await app.inject({
      method: "GET",
      url: `/exceptions${query}`,
      headers: { authorization: `Bearer ${TEST_REPORT_TOKEN}` },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      status: "invalid_request",
      message: "day must be a calendar date as YYYY-MM-DD",
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it("accepts the scheme in any letter case", async () => {
    const { app, connect } = setup();
    const response = await app.inject({
      method: "GET",
      url: "/exceptions",
      headers: { authorization: `bearer ${TEST_REPORT_TOKEN}` },
    });
    // Authorized: it reached the (fake, failing) database.
    expect(response.statusCode).toBe(500);
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
