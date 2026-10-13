import { z } from "zod";

export class ConfigError extends Error {
  override name = "ConfigError";
}

const envSchema = z.object({
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "must be a postgres:// connection string"),
  FAKEPAY_WEBHOOK_SECRET: z.string().min(32, "must be at least 32 characters"),
  // Bearer token for GET /exceptions, which returns payer names and amounts.
  REPORT_API_TOKEN: z.string().min(32, "must be at least 32 characters"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});

export interface AppConfig {
  databaseUrl: string;
  fakepayWebhookSecret: string;
  reportApiToken: string;
  port: number;
}

/** Validates the environment once at startup and fails with every problem listed. */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // Report variable names and rules only; never echo values, which may be secrets.
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    );
    throw new ConfigError(`Invalid environment:\n  ${problems.join("\n  ")}`);
  }
  return {
    databaseUrl: parsed.data.DATABASE_URL,
    fakepayWebhookSecret: parsed.data.FAKEPAY_WEBHOOK_SECRET,
    reportApiToken: parsed.data.REPORT_API_TOKEN,
    port: parsed.data.PORT,
  };
}
