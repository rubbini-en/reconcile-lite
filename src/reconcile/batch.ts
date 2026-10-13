// Reconciles a whole batch of payments. Pure: the database code loads the
// inputs and stores the output.
import type {
  MatchDecision,
  MatchingConfig,
  Order,
  OrderId,
  PaymentId,
  SettledPayment,
} from "../domain/types.js";
import { reconcilePayment } from "../matching/engine.js";

export interface PaymentDecision {
  paymentId: PaymentId;
  decision: MatchDecision;
}

/** Earliest settlement first; the provider ID breaks ties so reruns agree. */
function compareSettlement(left: SettledPayment, right: SettledPayment): number {
  const difference = left.settledAt.getTime() - right.settledAt.getTime();
  if (difference !== 0) return difference;
  if (left.providerPaymentId === right.providerPaymentId) return 0;
  return left.providerPaymentId < right.providerPaymentId ? -1 : 1;
}

/**
 * Payments are processed in settlement order, and each `matched` order is
 * claimed so later payments see it as taken. Only `matched` claims, the same
 * rule as the one-match-per-order index: an amount mismatch or a refund does
 * not mean the order was paid.
 */
export function reconcileBatch(
  payments: readonly SettledPayment[],
  orders: readonly Order[],
  config: Readonly<MatchingConfig>,
): PaymentDecision[] {
  const claimedOrderIds = new Set<OrderId>();
  return [...payments].sort(compareSettlement).map((payment) => {
    const decision = reconcilePayment({ payment, orders, claimedOrderIds, config });
    if (decision.status === "matched") claimedOrderIds.add(decision.orderId);
    return { paymentId: payment.id, decision };
  });
}
