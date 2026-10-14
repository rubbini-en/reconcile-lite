# Design decisions

Why reconcile-lite works the way it does, grouped by area. Deferred items, and
what should reopen them, are at the end.

## Money

- **Integer minor units plus a currency.** A single amount is a validated
  safe-integer `number` (≤ 2^53 − 1): the provider contract caps amounts there
  because `JSON.parse` loses precision above it, and `number` avoids `bigint`
  JSON problems. Accumulated refund totals are `bigint`, stored as Postgres
  `BIGINT`; a total above 2^63 − 1 would make ingestion fail, which would take
  over a thousand maximum-size refunds on one payment. Supported currencies are PYG (exponent 0) and USD
  (exponent 2); others are rejected at the boundary until added explicitly.
- **CSV amounts** are decimal strings in major units (`12.34`), converted to
  minor units by string parsing. Extra decimals are rejected, never rounded.
- **`refunded_minor` above 2^53 − 1** is capped at that value when loaded for
  matching. It is still a full refund, because amounts never exceed it; the
  exact total stays in the table.

## Webhooks

- **Idempotency key** is FakePay's event `id`
  (`webhook_events.provider_event_id UNIQUE`). A repeated `id` with an
  identical body is acknowledged with `200` and changes nothing; the same `id`
  with a different body is rejected with `409`.
- **Byte-exact raw body** is stored as `TEXT` with its SHA-256, next to a parsed
  `jsonb` copy. `jsonb` normalizes the document, so it cannot show what was
  signed.
- **Signature timestamp** is per delivery attempt (FakePay re-signs retries), so
  the 300 s tolerance never rejects a late but legitimate retry.
- **Out-of-order events:** payment state is rebuilt by replaying all of the
  payment's events ordered by `(occurred_at, id)`, under a per-payment advisory
  lock. A refund that arrives before settlement creates an unsettled payment
  row; unsettled payments are not reconciled.
- **Contract-violating refunds** (wrong currency, total above the settled
  amount, a reused `refund_id` with other values, a second settlement) are
  stored and flagged in `payments.anomalies`, never rejected or corrected.
  Rejecting is only possible when the settlement arrived first, so the same
  events would end in different states depending on arrival order.
- **Mixed refund currencies before settlement** add `refund_currency_mismatch`.
  There is no settled currency yet, so the stored `refunded_minor` still sums
  them, and the total is recomputed once the settlement arrives. The Markdown
  report shows "mixed currencies (see anomalies)" instead of that number; the
  CSV and the API keep the raw total next to the anomaly flag.
- **Unstorable text is a client error.** Postgres `jsonb` rejects NUL and lone
  UTF-16 surrogates. A body containing them anywhere (values or keys, including
  ignored fields) gets `400` before any database access; a `500` would make
  FakePay retry it forever.

## Matching

- **Three stages:** exact reference → amount + currency + time window → fuzzy.
  A low fuzzy score means `unmatched`; `ambiguous` needs at least two candidates
  over the threshold. Ambiguous results never carry an order (enforced by a
  table constraint).
- **Matching never picks between equals.** Two orders whose references are
  equal after trimming give `ambiguous` at the exact stage, and a tie for the
  best fuzzy score gives `ambiguous` even when `fuzzyMinLead` is 0.
- **Matching settings are a constant** (`DEFAULT_MATCHING_CONFIG`), so they are
  not validated at runtime.
- **Text normalization** decomposes accents and strips marks before
  lowercasing, so `İstanbul` becomes `istanbul`. Dotless `ı` stays its own
  letter and does not match `i`.
- **Fuzzy scores** are compared in integer thousandths. A score equal to the
  threshold is eligible; a lead equal to `fuzzyMinLead` picks the winner.
  Boundary tests use real Jaro-Winkler values (`martha`/`marhta` = 0.961), not
  mocked scores.
- **A money mismatch beats `duplicate`** at the exact stage: a claimed order
  with a different amount is reported as `amount_mismatch`.
- **Partial refunds** keep the payment's match status; `refunded_minor` tracks
  the refunded total. Status `refunded` is used only when the full amount is
  refunded.

## Reconciliation runs

- **Batch only.** Reconciliation runs from the CLI; webhooks do not trigger it.
- **One match per order** is enforced by a partial unique index on
  `reconciliation_results (order_id) WHERE status = 'matched'`. A later payment
  for an already-matched order is recorded as `duplicate`.
- **Order of processing:** settled payments, oldest settlement first
  (`settled_at`, then provider payment ID). Only `matched` claims an order, the
  same rule as the index; an amount mismatch or a full refund leaves the order
  free for a later payment.
- **A run replaces all results** (`DELETE` + `INSERT`) in one `REPEATABLE READ`
  transaction. Results are derived data, and row-by-row updates could briefly
  give two payments the same matched order. A session advisory lock allows one
  run at a time: a run that finds it taken exits at once with "a reconcile run
  is already in progress" instead of waiting behind a run that may hang. A
  refused run loses nothing, because the next run reads everything again.

## Order import

- **All-or-nothing and repeatable.** Every row is validated first and every
  problem is listed with its line number (names are never echoed).
  Re-importing an identical order is a no-op; an existing `order_ref` with
  different values aborts the whole import.
- **Strict input.** The header must match exactly, values are trimmed, and NUL
  characters and invalid UTF-8 are rejected. A file is capped at 10 MiB
  (checked before reading) and 100,000 rows; paths that are not regular files
  are refused.

## Exceptions report and API

- **One item per payment that needs a person:** a status other than `matched`,
  awaiting settlement, settled after the last run, a partial refund, an
  anomaly, or an outdated result. The optional UTC day filters by settlement
  time, or by first event for unsettled payments.
- **Outdated results** compare the `payments.updated_at` a run read (stored in
  `reconciliation_results.payment_updated_at`) with the current value.
  Comparing with the run time would mix the app and database clocks and miss a
  webhook that committed after the run's snapshot.
- **`GET /exceptions` requires a bearer token** (`REPORT_API_TOKEN`): it returns
  payer names and amounts. Tokens are compared as SHA-256 digests in constant
  time; responses are sent with `Cache-Control: no-store`.
- **Paging** uses `limit` (default 100, max 500) and a keyset `cursor` on the
  payment ID. When paging, the exception filter also runs in SQL so a page
  holds `limit` items; the cursor is the last row read. The CLI report is
  always complete.
- **Report output is untrusted text.** Markdown escapes table and markup
  characters. CSV prefixes an apostrophe to cells that start with
  `= + - @`, with whitespace before them, or with any control character, so
  spreadsheets do not run them as formulas.

## Simulator

- Sends a fixed fictional scenario covering every outcome, in a seeded random
  order with redeliveries and re-signed retries.
- Refuses any URL that is not 127.0.0.1, localhost or [::1], and refuses
  redirects, so deliveries never leave loopback.
- Its xorshift32 generator (Marsaglia, 2003) is for shuffling only, never for
  anything security-related.

## Operations

- **The server listens on `127.0.0.1` by default** (`HOST` overrides it).
  Exposing it is an explicit choice, expected behind a reverse proxy that adds
  TLS and rate limiting.
- **Logging:** the Fastify logger is on by default. Bodies and headers are
  always redacted. `5xx` responses log the error message, code and stack, never
  extra fields such as a database error's `detail`, which repeats row values.
  Config errors name the variable but never its value.
- **Integration tests** use a separate `reconcile_test` database. The test
  helper refuses any database whose name does not end in `_test`, because it
  drops the schema between tests.
- **Dependencies** are few and pinned exactly: fastify, zod and pg at runtime.
  CSV parsing, string similarity and HMAC handling are written in-house.
- **CI** runs lint, format check, typecheck, build, unit and integration tests
  against a Postgres service with throwaway credentials. It has read-only
  repository permission, uses no secrets, and pins actions by commit SHA.
  Postgres is pinned to `17.11-alpine` in Compose and CI.
- **CI commit tags.** The tip commit of every pushed branch must contain `[ci]`
  or `[skip ci]`. A versioned `pre-push` hook enforces it; `npm install` points
  `core.hooksPath` at `.githooks/`, warns when that replaces another hooks path,
  and does nothing outside a git checkout. The hook is client-side only:
  `git push --no-verify` bypasses it.

## Deferred, and when to revisit

Nothing below blocks current use. Each item names what should reopen it.

- **Unpaid orders are not reported.** The report is payment-centred; orders no
  payment matched do not appear. Deciding what "unpaid" means (age, currency,
  partial payment) belongs to real use. Revisit when someone needs to chase
  orders nobody has paid.
- **Matching settings validation.** Validate threshold, lead and window ranges
  at the boundary once the settings can be loaded from the environment or a
  file, the way `src/config.ts` validates the server settings.
- **Turkish dotless `ı`** does not match `i`. Revisit if real data includes
  Turkish names.
- **Scale.** A reconcile run loads every order into memory and inserts results
  one row at a time. Revisit with real data volumes and a measurement.
