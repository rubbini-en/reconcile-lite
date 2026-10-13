import { describe, expect, it } from "vitest";
import { eventSchema } from "../../../src/webhooks/schema.js";
import { refunded, settled } from "../../helpers/fakepay.js";

describe("event schema", () => {
  it.each([settled(), refunded(), settled({ currency: "USD", amount: 1234 })])(
    "accepts contract events",
    (event) => {
      expect(eventSchema.parse(event)).toEqual(event);
    },
  );
  it("ignores extra fields", () => {
    const event = settled();
    expect(
      eventSchema.parse({ ...event, extra: true, data: { ...event.data, extra: true } }),
    ).toEqual(event);
  });
  it("allows missing reference and nullable settlement text", () => {
    const event = settled();
    const { reference: _reference, ...fields } = event.data;
    expect(
      eventSchema.safeParse({ ...event, data: { ...fields, customer_name: null } }).success,
    ).toBe(true);
    expect(
      eventSchema.safeParse({ ...event, data: { ...fields, reference: null, customer_name: null } })
        .success,
    ).toBe(true);
  });
  it.each(["reference", "customer_name"])("accepts missing, null and string %s", (field) => {
    const event = settled();
    const fields = Object.fromEntries(Object.entries(event.data).filter(([key]) => key !== field));
    for (const data of [fields, { ...fields, [field]: null }, { ...fields, [field]: "text" }]) {
      expect(eventSchema.safeParse({ ...event, data }).success).toBe(true);
    }
  });
  it.each(["id", "type", "occurred_at", "data"])("rejects missing %s", (field) => {
    const event = Object.fromEntries(Object.entries(settled()).filter(([key]) => key !== field));
    expect(eventSchema.safeParse(event).success).toBe(false);
  });
  it.each([settled(), refunded()])("requires payment, amount and currency", (event) => {
    for (const field of ["payment_id", "amount_minor", "currency"]) {
      const fields = Object.fromEntries(
        Object.entries(event.data).filter(([key]) => key !== field),
      );
      expect(eventSchema.safeParse({ ...event, data: fields }).success).toBe(false);
    }
  });
  it.each([1.5, 0, -1, Number.MAX_SAFE_INTEGER + 1, "1234"])(
    "rejects invalid amount %s",
    (amount_minor) => {
      const event = settled();
      expect(
        eventSchema.safeParse({ ...event, data: { ...event.data, amount_minor } }).success,
      ).toBe(false);
    },
  );
  it.each(["usd", "EUR"])("rejects currency %s", (currency) => {
    const event = refunded();
    expect(eventSchema.safeParse({ ...event, data: { ...event.data, currency } }).success).toBe(
      false,
    );
  });
  it.each(["2026-10-12T14:00:00", "2026-10-12T14:00:00+00:00", "2026-02-30T00:00:00Z"])(
    "rejects timestamp %s",
    (occurred_at) => {
      expect(eventSchema.safeParse({ ...settled(), occurred_at }).success).toBe(false);
    },
  );
  it("enforces string bounds and required refund fields", () => {
    const event = settled();
    for (const id of ["", "x".repeat(65)])
      expect(eventSchema.safeParse({ ...event, id }).success).toBe(false);
    for (const [field, value] of [
      ["payment_id", ""],
      ["payment_id", "x".repeat(65)],
      ["reference", "x".repeat(129)],
      ["customer_name", "x".repeat(201)],
    ]) {
      expect(
        eventSchema.safeParse({ ...event, data: { ...event.data, [field as string]: value } })
          .success,
      ).toBe(false);
    }
    const { customer_name: _name, ...fields } = event.data;
    expect(eventSchema.safeParse({ ...event, data: fields }).success).toBe(true);
    const refund = refunded();
    const { refund_id: _id, ...refundFields } = refund.data;
    expect(eventSchema.safeParse({ ...refund, data: refundFields }).success).toBe(false);
    expect(eventSchema.safeParse({ ...event, type: "payment.unknown" }).success).toBe(false);
  });
});
