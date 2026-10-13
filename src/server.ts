import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";

async function startServer(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const app = buildApp({ pool, config });
  app.addHook("onClose", async () => {
    await pool.end();
  });
  const shutdown = () => {
    void app.close().catch(() => {
      console.error("Server shutdown failed");
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    await app.listen({ port: config.port, host: "0.0.0.0" });
  } catch (error) {
    await app.close();
    throw error;
  }
}

// ConfigError never contains values, so printing the error and its cause is safe.
void startServer().catch((error: unknown) => {
  console.error("Server startup failed", error);
  process.exitCode = 1;
});
