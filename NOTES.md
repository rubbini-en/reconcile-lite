# Notes

Working log of decisions and open questions. Newest entries at the bottom of
each section.

## Decisions

- **Partial refunds** keep the payment's match status; `refunded_minor` tracks
  the refunded total. Status `refunded` is used only when the full amount is
  refunded. Partial refunds get their own section in the exceptions report.
- **Idempotency key** is FakePay's event `id` (`webhook_events.provider_event_id
  UNIQUE`). A repeated `id` with an identical body is acknowledged with `200`
  and changes nothing; a repeated `id` with a different body is rejected with
  `409`.
- **Byte-exact raw body** is stored as `TEXT` with its SHA-256, next to a parsed
  `jsonb` copy. `jsonb` normalizes the document, so it cannot show what was
  signed.
- **Signature timestamp** is per delivery attempt (FakePay re-signs retries), so
  the 300 s tolerance never rejects a late but legitimate retry.
- **Out-of-order events:** payment state is rebuilt by replaying all of the
  payment's events ordered by `(occurred_at, id)`, under a per-payment advisory
  lock. A refund that arrives before settlement creates an unsettled payment
  row; unsettled payments are not reconciled.
- **Matching** runs exact reference → amount + currency + time window → fuzzy.
  A low fuzzy score means `unmatched`; `ambiguous` needs at least two candidates
  over the threshold. Ambiguous results never carry an order (enforced by a
  table constraint).
- **One match per order** is enforced by a partial unique index on
  `reconciliation_results (order_id) WHERE status = 'matched'`. A later payment
  for an already-matched order is recorded as `duplicate`.
- **Reconciliation** runs as a CLI batch only; webhooks do not trigger it.
- **Integration tests** use a separate `reconcile_test` database, created by the
  Postgres init script.

## Open questions

1. **Refunds that break the contract.** The contract says refunds never exceed
   the settled amount and use the payment's currency. If FakePay violates that,
   should the event be rejected (`400`), or stored and reported as an exception?
   Rejecting is not always possible: a refund can arrive before the settlement
   it must be checked against. To decide in milestone 1.
2. **Money type in TypeScript.** The plan said `bigint`. The contract caps
   amounts at 2^53 − 1 because `JSON.parse` loses precision above it, so a
   validated safe-integer `number` is enough and avoids `bigint` JSON
   serialization problems. Proposed; needs owner OK.
3. **Postgres image tag.** `postgres:17-alpine` is a floating tag. Pin to an
   exact version or digest before CI.

## Process log

- Step 0: the migration was applied by hand with `psql` to `reconcile_test` and
  its constraints were checked with a rolled-back script. This is not yet a
  committed automated test; it becomes one once the test tooling is approved.
