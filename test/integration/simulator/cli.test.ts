import { describe, expect, it } from "vitest";
import { runCli } from "../../helpers/cli.js";
import { TEST_SECRET } from "../../helpers/fakepay.js";

// Only failure paths here: they exit before writing a file or sending anything.
// The full flow runs in end-to-end.test.ts.
const simulate = (args: string[], env: Record<string, string | undefined> = {}) =>
  runCli("src/simulator/cli.ts", args, { FAKEPAY_WEBHOOK_SECRET: TEST_SECRET, ...env });

describe("npm run simulate", () => {
  it("refuses a URL that is not on this machine", async () => {
    const result = await simulate([
      "--orders-out",
      "never-written.csv",
      "--url",
      "https://example.com/webhooks/fakepay",
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Refusing https://example.com");
    expect(result.stdout).toBe("");
  });

  it("requires --orders-out", async () => {
    const result = await simulate([]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Usage: npm run simulate");
  });

  it("requires the webhook secret", async () => {
    const result = await simulate(["--orders-out", "never-written.csv"], {
      FAKEPAY_WEBHOOK_SECRET: undefined,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("FAKEPAY_WEBHOOK_SECRET must be set");
    expect(result.stdout).toBe("");
  });
});
