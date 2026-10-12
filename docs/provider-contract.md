# FakePay webhook contract

FakePay is a **fictional** payment provider invented for this project. It does
not describe any real provider's API. reconcile-lite is implemented against this
document only.

Version: 1 (draft, Step 0).

## Transport

- FakePay sends `POST` requests with `Content-Type: application/json` and a
  UTF-8 body to the merchant's endpoint (`/webhooks/fakepay` in this project).
- Every request carries a `FakePay-Signature` header (see [Signature](#signature)).
- FakePay gives **no ordering guarantee**. A `payment.refunded` event may arrive
  before the `payment.settled` event of the same payment.
- FakePay delivers **at least once**. The same event may be delivered more than
  once, including concurrently.

## Signature

```
FakePay-Signature: t=<unix_seconds>,v1=<hex_hmac>
```

- `t`: the time the **delivery attempt** was signed, in Unix seconds (UTC).
  Every attempt, including retries, is signed again with a new `t`.
- `v1`: lowercase hex of `HMAC-SHA256(secret, "<t>.<raw_body>")`, where
  `raw_body` is the exact request body bytes and `secret` is the shared webhook
  secret.
- The receiver must verify against the raw bytes, before parsing JSON, and must
  compare digests in constant time.
- The receiver rejects a signature whose `t` is more than **300 seconds** away
  from its own clock (past or future).
- A header that is missing or malformed (missing `t`, missing `v1`, non-numeric
  `t`, non-hex `v1`) is rejected.

Because each attempt is re-signed, the tolerance applies to the delivery, not to
the event. A retry hours after the event happened is still valid.

## Event envelope

```json
{
  "id": "evt_01J9Z3K8Q2",
  "type": "payment.settled",
  "occurred_at": "2026-10-12T14:03:00Z",
  "data": {}
}
```

| Field         | Type   | Rules                                                                        |
| ------------- | ------ | ---------------------------------------------------------------------------- |
| `id`          | string | Unique per event. Identical across every delivery of that event. 1–64 chars. |
| `type`        | string | `payment.settled` or `payment.refunded`. Other types are rejected.           |
| `occurred_at` | string | ISO-8601 UTC with a `Z` suffix. When the event happened at FakePay.          |
| `data`        | object | Depends on `type`.                                                           |

Every delivery of the same event has a byte-identical body. Only the
`FakePay-Signature` header changes between attempts.

## Money

- Amounts are JSON integers in the currency's **minor units**, in the field
  `amount_minor`. FakePay never sends decimal amounts.
- `amount_minor` is greater than 0 and at most 9007199254740991
  (2^53 − 1, the largest integer JSON parsers represent exactly).
- `currency` is an ISO-4217 alphabetic code: three uppercase letters.
- Minor-unit exponents used in this project: `PYG` = 0 (₲150000 is
  `150000`), `USD` = 2 (US$12.34 is `1234`).

## `payment.settled`

Funds for a payment were captured. FakePay sends **at most one**
`payment.settled` event per payment.

```json
{
  "id": "evt_01J9Z3K8Q2",
  "type": "payment.settled",
  "occurred_at": "2026-10-12T14:03:00Z",
  "data": {
    "payment_id": "pay_7HX2M4",
    "amount_minor": 150000,
    "currency": "PYG",
    "reference": "ORD-1042",
    "customer_name": "María Benítez"
  }
}
```

| Field           | Type           | Rules                                                                                                                |
| --------------- | -------------- | -------------------------------------------------------------------------------------------------------------------- |
| `payment_id`    | string         | FakePay payment ID. 1–64 chars.                                                                                      |
| `amount_minor`  | integer        | See [Money](#money).                                                                                                 |
| `currency`      | string         | See [Money](#money).                                                                                                 |
| `reference`     | string \| null | Free text typed by the payer or merchant. May be missing, mistyped, or not an order reference at all. Max 128 chars. |
| `customer_name` | string \| null | Free text as entered by the payer. Max 200 chars.                                                                    |

The settlement time is `occurred_at`.

## `payment.refunded`

Part or all of a settled payment was returned to the payer.

```json
{
  "id": "evt_01J9Z9P1W7",
  "type": "payment.refunded",
  "occurred_at": "2026-10-13T09:30:00Z",
  "data": {
    "payment_id": "pay_7HX2M4",
    "refund_id": "rf_3KD8",
    "amount_minor": 50000,
    "currency": "PYG"
  }
}
```

| Field          | Type    | Rules                                                    |
| -------------- | ------- | -------------------------------------------------------- |
| `payment_id`   | string  | The refunded payment.                                    |
| `refund_id`    | string  | Unique per refund. 1–64 chars.                           |
| `amount_minor` | integer | Amount of **this** refund (incremental, not cumulative). |
| `currency`     | string  | Same currency as the payment.                            |

A payment may have several refunds. Their sum never exceeds the settled
amount. Two events carrying the same `refund_id` describe the same refund.

## Responses expected from the receiver

| Situation                                                | Status |
| -------------------------------------------------------- | ------ |
| Event accepted (first delivery)                          | `200`  |
| Event already received with an identical body            | `200`  |
| Signature missing, malformed, wrong, or out of tolerance | `401`  |
| Body is not valid JSON or does not match this contract   | `400`  |
| Same `id` already received with a different body         | `409`  |
| Receiver error                                           | `5xx`  |

## Retries

FakePay retries any non-`2xx` response, re-signing each attempt. The number of
attempts and the backoff schedule are not part of this contract, and the
receiver must not depend on them.
