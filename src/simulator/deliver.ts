// Sends FakePay events the way the contract allows a provider to: in any
// order, more than once, and retried (and re-signed) after a non-2xx answer.
import type { FakePayEvent } from "../webhooks/schema.js";
import { signatureHeader } from "../webhooks/signature.js";
import { assertLoopbackUrl } from "./loopback.js";
import { createRandom, shuffle } from "./random.js";

export interface DeliveryOptions {
  url: string;
  secret: string;
  seed: number;
  /** Extra deliveries of randomly chosen events, as an at-least-once provider would make. */
  redeliveries?: number;
  maxAttempts?: number;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  nowSeconds?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface DeliverySummary {
  deliveries: number;
  attempts: number;
  /** Response body status ("processed", "duplicate") or "http <code>" for a final failure. */
  byStatus: Record<string, number>;
  failedEventIds: string[];
}

const DEFAULT_REDELIVERIES = 3;
const DEFAULT_MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 200;

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function deliveryPlan(events: readonly FakePayEvent[], seed: number, redeliveries: number) {
  const random = createRandom(seed);
  const repeats = Array.from(
    { length: events.length === 0 ? 0 : redeliveries },
    () => events[Math.floor(random() * events.length)] as FakePayEvent,
  );
  return shuffle([...events, ...repeats], random);
}

async function responseStatus(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { status?: unknown };
    return typeof body.status === "string" ? body.status : `http ${String(response.status)}`;
  } catch {
    return `http ${String(response.status)}`;
  }
}

export async function deliverEvents(
  events: readonly FakePayEvent[],
  options: DeliveryOptions,
): Promise<DeliverySummary> {
  const url = assertLoopbackUrl(options.url).href;
  const send = options.fetch ?? fetch;
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const sleep = options.sleep ?? wait;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const plan = deliveryPlan(events, options.seed, options.redeliveries ?? DEFAULT_REDELIVERIES);

  const summary: DeliverySummary = {
    deliveries: plan.length,
    attempts: 0,
    byStatus: {},
    failedEventIds: [],
  };
  for (const event of plan) {
    // Every delivery of an event carries the same bytes; only the signature changes.
    const body = JSON.stringify(event);
    for (let attempt = 1; ; attempt += 1) {
      summary.attempts += 1;
      const response = await send(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "fakepay-signature": signatureHeader(Buffer.from(body), options.secret, nowSeconds()),
        },
        body,
      });
      if (response.ok || attempt >= maxAttempts) {
        const status = response.ok
          ? await responseStatus(response)
          : `http ${String(response.status)}`;
        summary.byStatus[status] = (summary.byStatus[status] ?? 0) + 1;
        if (!response.ok) summary.failedEventIds.push(event.id);
        break;
      }
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  return summary;
}
