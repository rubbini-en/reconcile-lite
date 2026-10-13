import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { deliverEvents } from "./deliver.js";
import { assertLoopbackUrl, SimulatorError } from "./loopback.js";
import { buildScenario, ordersCsv } from "./scenario.js";

const USAGE =
  "Usage: npm run simulate -- --orders-out <orders.csv> [--url http://127.0.0.1:3000/webhooks/fakepay] [--seed 1]";
const MIN_SECRET_LENGTH = 32;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function readArguments() {
  try {
    const { values } = parseArgs({
      options: {
        url: { type: "string", default: "http://127.0.0.1:3000/webhooks/fakepay" },
        "orders-out": { type: "string" },
        seed: { type: "string", default: "1" },
      },
      strict: true,
    });
    const seed = Number(values.seed);
    if (values["orders-out"] === undefined || !Number.isSafeInteger(seed)) return fail(USAGE);
    return { url: assertLoopbackUrl(values.url).href, ordersOut: values["orders-out"], seed };
  } catch (error) {
    if (error instanceof SimulatorError) return fail(error.message);
    return fail(USAGE);
  }
}

const { url, ordersOut, seed } = readArguments();
const secret = process.env.FAKEPAY_WEBHOOK_SECRET;
if (secret === undefined || secret.length < MIN_SECRET_LENGTH) {
  fail("FAKEPAY_WEBHOOK_SECRET must be set (at least 32 characters, the same as the app's)");
}

const scenario = buildScenario();
await writeFile(ordersOut, ordersCsv(scenario.orders));
console.log(`Wrote ${String(scenario.orders.length)} fictional orders to ${ordersOut}`);
const summary = await deliverEvents(scenario.events, { url, secret, seed });
console.log(
  `Sent ${String(summary.deliveries)} deliveries (${String(summary.attempts)} attempts) to ${url}`,
);
for (const [status, count] of Object.entries(summary.byStatus)) {
  console.log(`  ${status.padEnd(12)}${String(count)}`);
}
if (summary.failedEventIds.length > 0) {
  fail(`Failed after retries: ${summary.failedEventIds.join(", ")}`);
}
