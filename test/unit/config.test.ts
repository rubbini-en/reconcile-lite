import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config.js";

const validEnv = {
  DATABASE_URL: "postgres://user:pass@127.0.0.1:54329/reconcile",
  FAKEPAY_WEBHOOK_SECRET: "a".repeat(32),
  REPORT_API_TOKEN: "r".repeat(32),
  PORT: "3000",
};

describe("loadConfig", () => {
  it("parses a valid environment", () => {
    expect(loadConfig(validEnv)).toEqual({
      databaseUrl: validEnv.DATABASE_URL,
      fakepayWebhookSecret: validEnv.FAKEPAY_WEBHOOK_SECRET,
      reportApiToken: validEnv.REPORT_API_TOKEN,
      port: 3000,
      host: "127.0.0.1",
    });
  });

  it("listens on loopback only unless HOST says otherwise", () => {
    expect(loadConfig(validEnv).host).toBe("127.0.0.1");
    expect(loadConfig({ ...validEnv, HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
  });

  it("rejects an empty HOST", () => {
    expect(() => loadConfig({ ...validEnv, HOST: "" })).toThrow(/HOST/);
  });

  it("defaults PORT to 3000", () => {
    const { PORT: _omitted, ...withoutPort } = validEnv;
    expect(loadConfig(withoutPort).port).toBe(3000);
  });

  it("fails naming the missing variable", () => {
    const { FAKEPAY_WEBHOOK_SECRET: _omitted, ...env } = validEnv;
    expect(() => loadConfig(env)).toThrow(/FAKEPAY_WEBHOOK_SECRET/);
  });

  it("requires a report API token of at least 32 characters", () => {
    const { REPORT_API_TOKEN: _omitted, ...env } = validEnv;
    expect(() => loadConfig(env)).toThrow(/REPORT_API_TOKEN/);
    expect(() => loadConfig({ ...validEnv, REPORT_API_TOKEN: "short" })).toThrow(
      /REPORT_API_TOKEN: must be at least 32 characters/,
    );
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
    const token = "leaky-token";
    expect(() => loadConfig({ ...validEnv, REPORT_API_TOKEN: token })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(token) as unknown }),
    );
  });
});
