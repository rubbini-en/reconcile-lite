import path from "node:path";
import { createPool } from "./pool.js";
import { migrate } from "./migrate.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const pool = createPool(databaseUrl);
try {
  const applied = await migrate(pool, path.resolve("migrations"));
  console.log(applied.length > 0 ? `Applied: ${applied.join(", ")}` : "No pending migrations");
} finally {
  await pool.end();
}
