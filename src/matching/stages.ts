// The three matching stages. Each is a pure function over already-loaded data.
// Stages a and b return null to hand over to the next stage; stage c is last and
// always decides.
import type {
  MatchDecision,
  MatchingConfig,
  Order,
  OrderId,
  SettledPayment,
} from "../domain/types.js";
import { normalizeName, normalizeReference } from "./normalize.js";
import { jaroWinkler, toThousandths } from "./similarity.js";

type Claimed = ReadonlySet<OrderId>;

const MS_PER_HOUR = 3_600_000;

/** Order IDs are BIGSERIAL strings; compare them as numbers, not text ("10" > "9"). */
export function compareNumericIds(left: OrderId, right: OrderId): number {
  const difference = BigInt(left) - BigInt(right);
  return difference === 0n ? 0 : difference < 0n ? -1 : 1;
}

function sortedIds(orders: readonly Order[]): OrderId[] {
  return orders.map((order) => order.id).sort(compareNumericIds);
}

function withinHours(order: Order, payment: SettledPayment, hours: number): boolean {
  return Math.abs(order.createdAt.getTime() - payment.settledAt.getTime()) <= hours * MS_PER_HOUR;
}

function sameMoney(order: Order, payment: SettledPayment): boolean {
  return order.currency === payment.currency && order.amountMinor === payment.amountMinor;
}

/** Stage a: the trimmed reference equals the order ref (case-sensitive). */
export function matchExactReference(
  payment: SettledPayment,
  orders: readonly Order[],
  claimed: Claimed,
): MatchDecision | null {
  const reference = payment.reference?.trim() ?? "";
  if (reference === "") return null;
  const found = orders.filter((order) => order.orderRef.trim() === reference);
  const [order] = found;
  if (order === undefined) return null;
  // Order refs are unique in the database, but two can collide after trimming.
  // The engine never picks one of several candidates.
  if (found.length > 1) {
    return { status: "ambiguous", stage: "exact_reference", candidateOrderIds: sortedIds(found) };
  }
  return {
    status: exactReferenceStatus(order, payment, claimed),
    orderId: order.id,
    stage: "exact_reference",
    confidence: null,
  };
}

// A money mismatch is reported even for a claimed order: it is the more
// actionable problem.
function exactReferenceStatus(order: Order, payment: SettledPayment, claimed: Claimed) {
  if (!sameMoney(order, payment)) return "amount_mismatch";
  return claimed.has(order.id) ? "duplicate" : "matched";
}

/** Stage b: same amount and currency, created within the time window. */
export function matchAmountTimeWindow(
  payment: SettledPayment,
  orders: readonly Order[],
  claimed: Claimed,
  config: Readonly<MatchingConfig>,
): MatchDecision | null {
  const candidates = orders.filter(
    (order) =>
      !claimed.has(order.id) &&
      sameMoney(order, payment) &&
      withinHours(order, payment, config.timeWindowHours),
  );
  const [order] = candidates;
  if (order === undefined) return null;
  if (candidates.length > 1) {
    return {
      status: "ambiguous",
      stage: "amount_time_window",
      candidateOrderIds: sortedIds(candidates),
    };
  }
  return { status: "matched", orderId: order.id, stage: "amount_time_window", confidence: null };
}

/** Missing data is not evidence: an empty side scores 0 instead of comparing. */
function similarity(left: string, right: string): number {
  return left === "" || right === "" ? 0 : jaroWinkler(left, right);
}

/** Best of reference and name similarity, in integer thousandths. */
function scoreThousandths(payment: SettledPayment, order: Order): number {
  return toThousandths(
    Math.max(
      similarity(normalizeReference(payment.reference), normalizeReference(order.orderRef)),
      similarity(normalizeName(payment.customerName), normalizeName(order.customerName)),
    ),
  );
}

/** Stage c: best similarity of reference or name; amount may differ. */
export function matchFuzzy(
  payment: SettledPayment,
  orders: readonly Order[],
  claimed: Claimed,
  config: Readonly<MatchingConfig>,
): MatchDecision {
  const threshold = toThousandths(config.fuzzyThreshold);
  const minLead = toThousandths(config.fuzzyMinLead);
  const eligible = orders
    .filter(
      (order) =>
        !claimed.has(order.id) &&
        order.currency === payment.currency &&
        withinHours(order, payment, config.fuzzyWindowHours),
    )
    .map((order) => ({ order, score: scoreThousandths(payment, order) }))
    .filter((candidate) => candidate.score >= threshold);
  if (eligible.length === 0) return { status: "unmatched" };

  const best = Math.max(...eligible.map((candidate) => candidate.score));
  const contenders = eligible.filter(
    (candidate) => candidate.score === best || best - candidate.score < minLead,
  );
  const [winner, ...runnersUp] = contenders;
  // A tie for the best score is ambiguous even when fuzzyMinLead is 0.
  if (winner !== undefined && runnersUp.length === 0) {
    return {
      status: sameMoney(winner.order, payment) ? "matched" : "amount_mismatch",
      orderId: winner.order.id,
      stage: "fuzzy",
      confidence: winner.score / 1000,
    };
  }
  return {
    status: "ambiguous",
    stage: "fuzzy",
    candidateOrderIds: sortedIds(contenders.map((candidate) => candidate.order)),
  };
}
