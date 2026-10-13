import { z } from "zod";
import { isCurrencyCode, type CurrencyCode } from "../money.js";

const identifier = z.string().min(1).max(64);
const envelope = {
  id: identifier,
  occurred_at: z.iso.datetime(),
};
const payment = {
  payment_id: identifier,
  amount_minor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  currency: z.custom<CurrencyCode>(isCurrencyCode),
};

export const eventSchema = z.discriminatedUnion("type", [
  z.object({
    ...envelope,
    type: z.literal("payment.settled"),
    data: z.object({
      ...payment,
      reference: z.string().max(128).nullable().optional(),
      customer_name: z.string().max(200).nullable().optional(),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal("payment.refunded"),
    data: z.object({ ...payment, refund_id: identifier }),
  }),
]);

export type FakePayEvent = z.infer<typeof eventSchema>;
