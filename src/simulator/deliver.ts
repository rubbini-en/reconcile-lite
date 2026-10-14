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
  fetch?: Send;
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

type Send = (url: string, init: RequestInit) => Promise<Response>;

/** One POST. A network failure (the app is down, a reset) is a failed attempt, not a crash. */
async function attempt(
  send: Send,
  url: string,
  body: string,
  signature: string,
): Promise<{ ok: boolean; status: string }> {
  let response: Response;
  try {
    response = await send(url, {
      method: "POST",
      headers: { "content-type": "application/json", "fakepay-signature": signature },
      body,
      // A redirect could point anywhere; the loopback check only covers the first URL.
      redirect: "error",
    });
  } catch {
    return { ok: false, status: "network error" };
  }
  return response.ok
    ? { ok: true, status: await responseStatus(response) }
    : { ok: false, status: `http ${String(response.status)}` };
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
    for (let attemptNumber = 1; ; attemptNumber += 1) {
      summary.attempts += 1;
      const signature = signatureHeader(Buffer.from(body), options.secret, nowSeconds());
      const result = await attempt(send, url, body, signature);
      if (result.ok || attemptNumber >= maxAttempts) {
        summary.byStatus[result.status] = (summary.byStatus[result.status] ?? 0) + 1;
        if (!result.ok) summary.failedEventIds.push(event.id);
        break;
      }
      await sleep(RETRY_DELAY_MS * attemptNumber);
    }
  }
  return summary;
}
