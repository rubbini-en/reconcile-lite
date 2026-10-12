import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config.js";

const validEnv = {
  DATABASE_URL: "postgres://user:pass@127.0.0.1:54329/reconcile",
  FAKEPAY_WEBHOOK_SECRET: "a".repeat(32),
  PORT: "3000",
};

describe("loadConfig", () => {
  it("parses a valid environment", () => {
    expect(loadConfig(validEnv)).toEqual({
      databaseUrl: validEnv.DATABASE_URL,
      fakepayWebhookSecret: validEnv.FAKEPAY_WEBHOOK_SECRET,
      port: 3000,
    });
  });

  it("defaults PORT to 3000", () => {
    const { PORT: _omitted, ...withoutPort } = validEnv;
    expect(loadConfig(withoutPort).port).toBe(3000);
  });

  it("fails naming the missing variable", () => {
    const { FAKEPAY_WEBHOOK_SECRET: _omitted, ...env } = validEnv;
    expect(() => loadConfig(env)).toThrow(/FAKEPAY_WEBHOOK_SECRET/);
  });

  it("rejects a webhook secret shorter than 32 characters", () => {
    expect(() => loadConfig({ ...validEnv, FAKEPAY_WEBHOOK_SECRET: "short" })).toThrow(ConfigError);
  });

  it("rejects a non-postgres DATABASE_URL", () => {
    expect(() => loadConfig({ ...validEnv, DATABASE_URL: "mysql://x" })).toThrow(/DATABASE_URL/);
  });

  it("never includes the secret in the error message", () => {
    const secret = "leaky-secret";
    try {
      loadConfig({ ...validEnv, FAKEPAY_WEBHOOK_SECRET: secret });
      expect.unreachable("loadConfig should have thrown");
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});
