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
  Postgres init script. The test helper refuses any database whose name does
  not end in `_test`, because it drops the schema between tests.
- **Dependencies** (owner-approved, exact pins): fastify, zod, pg; dev:
  typescript 5.9.3 (typescript-eslint does not support TypeScript 7 yet),
  tsx, vitest, @types/node 22, @types/pg, eslint, @eslint/js,
  typescript-eslint, prettier. CSV parsing, string similarity and HMAC are
  written in-house.
- **Branches:** one per milestone (`milestone/N-name`). The owner merges into
  `main`; agents never do. Codex and Antigravity work in git worktrees under
  `.worktrees/` (gitignored) so nothing leaves the project directory.
- **Supported currencies** are PYG (exponent 0) and USD (exponent 2). Others are
  rejected at the boundary until added explicitly.
- **CSV amounts** are decimal strings in major units (`12.34`), converted to
  minor units by string parsing. Extra decimals are rejected, never rounded.

- **Contract-violating refunds** (wrong currency, total above the settled
  amount, a reused `refund_id` with other values, a second settlement) are
  stored and flagged in `payments.anomalies`, never rejected or corrected.
  Rejecting is only possible when the settlement arrived first, so the same
  events would end in different states depending on arrival order.
- **Agents do not commit.** Codex and Antigravity leave changes uncommitted in
  their worktrees; the integrator reviews the diff, runs every check, and
  commits in small units.
- **Unstorable text is a client error.** Postgres `jsonb` rejects NUL and lone
  UTF-16 surrogates. A body containing them anywhere (values or keys, including
  ignored fields) gets `400` before any database access; a `500` would make
  FakePay retry it forever.
- **Logging:** the Fastify logger is on by default. Bodies and headers are
  always redacted; `5xx` responses log the error message, code, request id and
  event id. Startup failures print the error and its cause (config errors never
  contain values).
- **Mixed refund currencies before settlement** add `refund_currency_mismatch`.
  There is no settled currency yet, so `refunded_minor` still sums them (see
  open question 3).
- **Matching never picks between equals.** Two orders whose references are
  equal after trimming give `ambiguous` at the exact stage, and a tie for the
  best fuzzy score gives `ambiguous` even when `fuzzyMinLead` is 0.
- **Fuzzy scores** are compared in integer thousandths. A score equal to the
  threshold is eligible; a lead equal to `fuzzyMinLead` picks the winner.
  Boundary tests use real Jaro-Winkler values (`martha`/`marhta` = 0.961), not
  mocked scores.
- **A money mismatch beats `duplicate`** at the exact stage: a claimed order
  with a different amount is reported as `amount_mismatch`.
- **Reconcile runs** process settled payments oldest settlement first
  (`settled_at`, then provider payment ID). Only `matched` claims an order, the
  same rule as the one-match-per-order index; an amount mismatch or a full
  refund leaves the order free for a later payment.
- **A run replaces all results** (`DELETE` + `INSERT`) in one `REPEATABLE READ`
  transaction. Results are derived data, and row-by-row updates could briefly
  give two payments the same matched order. A session advisory lock (726_002)
  makes concurrent runs wait, so each reads what the previous one committed.
- **Known limit:** a run loads every order and inserts results one row at a
  time. Fine for this project's scale; not measured on large data.

## Open questions

1. **Money type in TypeScript.** The plan said `bigint`. The contract caps
   amounts at 2^53 − 1 because `JSON.parse` loses precision above it, so a
   validated safe-integer `number` is enough and avoids `bigint` JSON
   serialization problems. Proposed; needs owner OK.
2. **Postgres image tag.** `postgres:17-alpine` is a floating tag. Pin to an
   exact version or digest before CI.
3. **Unsettled `refunded_minor` across currencies.** Before settlement, refunds
   in different currencies are summed into one number (flagged with
   `refund_currency_mismatch`). Unsettled payments are never reconciled, and the
   total is recomputed once the settlement arrives, so this is only visible in
   the raw row. Alternative: store 0 until settled. Not decided.
4. ~~**`refunded_minor` above 2^53 − 1.**~~ Resolved in milestone 2: the
   loader caps it at 2^53 − 1, which is still a full refund because amounts
   never exceed that value; the exact total stays in the table.
5. **Review suggestions on matching** (non-blocking, for the reconcile runner):
   validate `MatchingConfig` ranges when loading it (threshold in 0..1, lead
   ≥ 0); `compareNumericIds` throws on a non-numeric ID, which only database
   IDs reach today; `normalizeText` removes marks before lowercasing, so a
   letter like `İ` keeps a stray mark after lowercasing.

## Process log

- Step 0: the migration was applied by hand with `psql` to `reconcile_test` and
  its constraints were checked with a rolled-back script. Those checks are now
  automated in `test/integration/schema.test.ts`.
- Step 0: owner approved resetting the `reconcile_test` schema for tests.
  Integration tests ran: 17/17 passed (full suite 64/64). A mutation check
  (ambiguous CHECK and the one-match-per-order index removed) made exactly the
  3 related tests fail; the schema was then restored.
- `.atl/` is generated by local agent tooling and holds absolute home paths;
  it is gitignored and must never be committed.
- Milestone 1: Codex wrote ingestion (round 1 approved by two reviews). Round 2
  stopped with 8 failing tests written; a native review required one bounded
  correction, which Codex could not run (its tool host timed out). The
  integrator applied it without changing any test assertion (only lint and type
  fixes in test files), and the review approved it. Antigravity stopped before
  `stages.ts`/`engine.ts`; the integrator finishes matching in milestone 2.
- Milestone 2 (matching): the integrator finished Antigravity's work. Two
  stage tests that could not fail (a boundary test scoring 1.0 and a test that
  only checked a config constant) were replaced with real boundary tests, and a
  prefix-cap test was tightened to an exact score. Mutation checks: flipping
  each threshold, lead, window and tie rule, and the full-refund boundary,
  made at least one test fail every time.
- Milestone 2 (runner): the runner was assigned to the integrator because
  Codex's tool host had failed. Mutation checks: removing the run lock failed
  the concurrency test 3/3; removing the delete, the 2^53 cap, or the
  settlement sort each failed their own tests. The CLI was run once against
  `reconcile_test` with 4 fictional payments.
