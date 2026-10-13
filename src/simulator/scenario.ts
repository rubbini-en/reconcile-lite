// A fixed, fictional set of orders and FakePay events that exercises every
// reconciliation outcome. Every name, reference and ID here is invented.
import { formatCsvRow } from "../csv.js";
import type { MatchStage } from "../domain/types.js";
import { formatDecimalAmount, type CurrencyCode } from "../money.js";
import { ORDERS_CSV_HEADER, type NewOrder } from "../orders/csv-import.js";
import type { ExceptionStatus } from "../report/exceptions.js";
import type { FakePayEvent } from "../webhooks/schema.js";

export interface ExpectedOutcome {
  status: ExceptionStatus;
  orderRef: string | null;
  stage: MatchStage | null;
  partialRefund: boolean;
}

export interface Scenario {
  orders: NewOrder[];
  events: FakePayEvent[];
  /** Expected result per FakePay payment ID once orders are imported and reconciled. */
  expected: Record<string, ExpectedOutcome>;
}

const SETTLED_AT = Date.parse("2026-10-10T14:00:00Z");
const HOUR = 3_600_000;
const at = (offsetHours: number) => new Date(SETTLED_AT + offsetHours * HOUR);
const iso = (offsetHours: number) => at(offsetHours).toISOString().replace(".000Z", "Z");

function order(
  orderRef: string,
  customerName: string,
  amountMinor: number,
  currency: CurrencyCode,
  createdOffsetHours: number,
): NewOrder {
  return { orderRef, customerName, amountMinor, currency, createdAt: at(createdOffsetHours) };
}

interface SettlementFields {
  amount: number;
  currency?: CurrencyCode;
  reference?: string | null;
  customerName?: string | null;
  offsetHours?: number;
}

class EventFactory {
  private counter = 0;
  readonly events: FakePayEvent[] = [];

  settled(paymentId: string, fields: SettlementFields): void {
    this.events.push({
      id: this.nextId(),
      type: "payment.settled",
      occurred_at: iso(fields.offsetHours ?? 0),
      data: {
        payment_id: paymentId,
        amount_minor: fields.amount,
        currency: fields.currency ?? "PYG",
        reference: fields.reference ?? null,
        customer_name: fields.customerName ?? null,
      },
    });
  }

  refunded(
    paymentId: string,
    refundId: string,
    amount: number,
    offsetHours: number,
    currency: CurrencyCode = "PYG",
  ): void {
    this.events.push({
      id: this.nextId(),
      type: "payment.refunded",
      occurred_at: iso(offsetHours),
      data: { payment_id: paymentId, refund_id: refundId, amount_minor: amount, currency },
    });
  }

  private nextId(): string {
    this.counter += 1;
    return `evt_sim_${String(this.counter).padStart(3, "0")}`;
  }
}

const outcome = (
  status: ExceptionStatus,
  orderRef: string | null = null,
  stage: MatchStage | null = null,
  partialRefund = false,
): ExpectedOutcome => ({ status, orderRef, stage, partialRefund });

export function buildScenario(): Scenario {
  const orders = [
    order("ORD-SIM-1001", "Ana Duarte", 150000, "PYG", -2),
    order("ORD-SIM-1002", "Bruno Ayala", 1234, "USD", -2),
    order("ORD-SIM-1003", "Carla Rojas", 99000, "PYG", -2),
    // Ten days old: outside the 72 h amount window, inside the fuzzy window.
    order("ORD-SIM-1004", "María Benítez", 75000, "PYG", -240),
    order("ORD-SIM-1005", "Diego Benitez", 50000, "PYG", -3),
    order("ORD-SIM-1015", "Eva Gimenez", 50000, "PYG", -4),
    order("ORD-SIM-1006", "Fabio Mora", 20000, "PYG", -2),
    order("ORD-SIM-1007", "Gloria Paez", 60000, "PYG", -2),
    order("ORD-SIM-1008", "Hugo Rivas", 5000, "USD", -2),
    order("ORD-SIM-1009", "Irene Sosa", 30000, "PYG", -24),
  ];

  const make = new EventFactory();
  make.settled("pay_sim_exact", { amount: 150000, reference: "ORD-SIM-1001" });
  make.settled("pay_sim_window", { amount: 1234, currency: "USD", reference: "invoice 77" });
  make.settled("pay_sim_fuzzy", { amount: 98000, customerName: "Carla Roxas" });
  make.settled("pay_sim_typo", { amount: 75000, customerName: "Maria Benites" });
  make.settled("pay_sim_ambiguous", { amount: 50000 });
  make.settled("pay_sim_unmatched", {
    amount: 999,
    currency: "USD",
    reference: "gift",
    customerName: "Zulma Zarate",
  });
  make.settled("pay_sim_first", { amount: 20000, reference: "ORD-SIM-1006" });
  make.settled("pay_sim_second", { amount: 20000, reference: "ORD-SIM-1006", offsetHours: 1 });
  make.settled("pay_sim_refunded", { amount: 60000, reference: "ORD-SIM-1007" });
  make.refunded("pay_sim_refunded", "rf_sim_a", 20000, 24);
  make.refunded("pay_sim_refunded", "rf_sim_b", 40000, 48);
  make.settled("pay_sim_partial", { amount: 5000, currency: "USD", reference: "ORD-SIM-1008" });
  make.refunded("pay_sim_partial", "rf_sim_c", 1500, 24, "USD");
  // A refund whose settlement never arrives.
  make.refunded("pay_sim_waiting", "rf_sim_d", 10000, 24);

  return {
    orders,
    events: make.events,
    expected: {
      pay_sim_exact: outcome("matched", "ORD-SIM-1001", "exact_reference"),
      pay_sim_window: outcome("matched", "ORD-SIM-1002", "amount_time_window"),
      pay_sim_fuzzy: outcome("amount_mismatch", "ORD-SIM-1003", "fuzzy"),
      pay_sim_typo: outcome("matched", "ORD-SIM-1004", "fuzzy"),
      pay_sim_ambiguous: outcome("ambiguous", null, "amount_time_window"),
      pay_sim_unmatched: outcome("unmatched"),
      pay_sim_first: outcome("matched", "ORD-SIM-1006", "exact_reference"),
      pay_sim_second: outcome("duplicate", "ORD-SIM-1006", "exact_reference"),
      pay_sim_refunded: outcome("refunded", "ORD-SIM-1007", "exact_reference"),
      pay_sim_partial: outcome("matched", "ORD-SIM-1008", "exact_reference", true),
      pay_sim_waiting: outcome("awaiting_settlement"),
    },
  };
}

/** The orders as a CSV file in the format `npm run import:orders` reads. */
export function ordersCsv(orders: readonly NewOrder[]): string {
  const rows = orders.map((entry) =>
    formatCsvRow([
      entry.orderRef,
      entry.customerName,
      formatDecimalAmount(entry.amountMinor, entry.currency),
      entry.currency,
      entry.createdAt.toISOString(),
    ]),
  );
  return [formatCsvRow(ORDERS_CSV_HEADER), ...rows, ""].join("\n");
}
