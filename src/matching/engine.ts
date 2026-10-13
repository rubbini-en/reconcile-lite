// Reconciles one settled payment against the loaded orders. Pure: no I/O, no
// clock, no randomness; the result does not depend on the order of the inputs.
import type { MatchDecision, MatchInput, ReconcilePayment } from "../domain/types.js";
import { matchAmountTimeWindow, matchExactReference, matchFuzzy } from "./stages.js";

/** The first stage that decides wins; the fuzzy stage always decides. */
function decideMatch({ payment, orders, claimedOrderIds, config }: MatchInput): MatchDecision {
  return (
    matchExactReference(payment, orders, claimedOrderIds) ??
    matchAmountTimeWindow(payment, orders, claimedOrderIds, config) ??
    matchFuzzy(payment, orders, claimedOrderIds, config)
  );
}

/**
 * A fully refunded payment is reported as refunded, but keeps the order it
 * matched so the refund can be traced to it. A partial refund changes nothing.
 */
function applyFullRefund(decision: MatchDecision): MatchDecision {
  switch (decision.status) {
    case "matched":
    case "amount_mismatch":
    case "duplicate":
      return {
        status: "refunded",
        orderId: decision.orderId,
        stage: decision.stage,
        confidence: decision.confidence,
      };
    case "ambiguous":
    case "unmatched":
      return { status: "refunded", orderId: null, stage: null, confidence: null };
    case "refunded":
      return decision;
  }
}

export const reconcilePayment: ReconcilePayment = (input) => {
  const decision = decideMatch(input);
  const fullyRefunded = input.payment.refundedMinor >= input.payment.amountMinor;
  return fullyRefunded ? applyFullRefund(decision) : decision;
};
