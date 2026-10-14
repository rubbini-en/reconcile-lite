# reconcile-lite

A small TypeScript service that reconciles payments from a payment provider
against a merchant's orders and reports the cases that need a person.

The provider is **FakePay**, a fictional provider invented for this project.
Its webhook contract is in [docs/provider-contract.md](docs/provider-contract.md).
It does not describe any real provider. All names, references and IDs in the
fixtures and the simulator are invented.

This is a portfolio project. It has not run in production, has no users, and
has not been load-tested.

## What it does

1. **Receives webhooks** at `POST /webhooks/fakepay` (`payment.settled`,
   `payment.refunded`).
   - Verifies an HMAC-SHA256 signature over the raw body, with a 300 s
     tolerance.
   - Stores each event once, keyed by the event ID. A redelivery with the same
     body returns 200; the same ID with a different body returns 409.
   - Accepts events in any order. Payment state is rebuilt from every stored
     event, so a refund that arrives before its settlement is not lost.
2. **Imports orders** from a CSV file. The import is all-or-nothing: one bad row
   rejects the file, with every problem listed by line number. Importing the
   same file twice is a no-op.
3. **Reconciles** settled payments against orders in three stages, stopping at
   the first stage that decides:
   1. exact reference;
   2. amount + currency, with the order created within 72 h of settlement;
   3. fuzzy: Jaro-Winkler similarity on the reference or the customer name,
      within 720 h, with a minimum score and a minimum lead over the runner-up.

   Each payment gets one status: `matched`, `ambiguous`, `unmatched`,
   `amount_mismatch`, `duplicate` or `refunded`. When two orders are equally
   good, the result is `ambiguous`; the service never picks one.

4. **Reports exceptions**: every payment that needs attention, as Markdown or CSV
   from the CLI, or as JSON from `GET /exceptions` (bearer token required).
   Results that are older than the latest change to their payment are flagged.

Money is stored as integer minor units with a currency (PYG and USD are
supported). All times are UTC.

## Requirements

- Node.js 22 (see `.nvmrc`)
- Docker, for the local PostgreSQL 17 database

## Running it locally

```sh
npm ci
docker compose up -d          # Postgres on 127.0.0.1:54329, plus a reconcile_test database
```

The app reads its settings from environment variables. There is no
`.env.example` yet (see [NOTES.md](NOTES.md), open question 8), so export
them in your shell:

| Variable                 | Used by                    | Rule                            |
| ------------------------ | -------------------------- | ------------------------------- |
| `DATABASE_URL`           | server and all CLIs        | `postgres://` connection string |
| `FAKEPAY_WEBHOOK_SECRET` | server, `npm run simulate` | at least 32 characters          |
| `REPORT_API_TOKEN`       | server (`GET /exceptions`) | at least 32 characters          |
| `PORT`                   | server                     | optional, default 3000          |

```sh
export DATABASE_URL=postgres://reconcile:reconcile_local@127.0.0.1:54329/reconcile
export FAKEPAY_WEBHOOK_SECRET=$(openssl rand -hex 32)
export REPORT_API_TOKEN=$(openssl rand -hex 32)

npm run db:migrate
npm run build && npm start    # http://127.0.0.1:3000
```

The database credentials above are the throwaway defaults from
`docker-compose.yml`, which binds Postgres to localhost only.

### Try the whole flow with the simulator

In a second shell with the same variables:

```sh
# Send a fixed fictional scenario of FakePay events to the local server,
# shuffled and with redeliveries, and write the matching orders to a CSV file.
npm run simulate -- --orders-out orders.csv --seed 1

npm run import:orders -- orders.csv
npm run reconcile
npm run report                       # Markdown; add --format csv or --day YYYY-MM-DD

curl -H "Authorization: Bearer $REPORT_API_TOKEN" http://127.0.0.1:3000/exceptions
```

The simulator only sends to loopback addresses (`127.0.0.1`, `localhost`,
`[::1]`). The scenario is built so that every status appears, including a
partial refund and a refund whose settlement never arrives.

### Orders CSV format

```csv
order_ref,customer_name,amount,currency,created_at
ORD-1001,María Benítez,150000,PYG,2026-10-10T12:00:00Z
ORD-1002,"Acosta, Rodrigo",12.34,USD,2026-10-11T08:30:00Z
```

`amount` is in major units (`12.34` USD is stored as 1234 cents).
`created_at` must be an ISO 8601 UTC timestamp ending in `Z`.

## Tests

```sh
npm test                    # unit + integration
npm run test:unit           # no database needed
npm run test:integration    # needs the Docker database
```

Integration tests run against a real PostgreSQL database, `reconcile_test`, and
drop and recreate its schema between tests. The helper refuses any database
whose name does not end in `_test`. Set `TEST_DATABASE_URL` to use another one.

Other checks: `npm run lint`, `npm run format:check`, `npm run typecheck`,
`npm run build`.

`.github/workflows/ci.yml` runs these checks and both test suites on GitHub
Actions against a Postgres 17.11 service container. **It has not run on GitHub
yet**; its steps were run locally, in order, against the Docker database.

## Project layout

```
src/
  webhooks/    signature check, event schema, ingestion, route
  payments/    payment state rebuilt from events
  orders/      CSV validation, import, CLI
  matching/    normalization, similarity, the three stages, engine
  reconcile/   batch run (one transaction, one run at a time), CLI
  report/      exceptions query, Markdown/CSV rendering, CLI, route
  simulator/   fictional scenario, delivery with retries, CLI
  db/          pool and plain-SQL migration runner
migrations/    plain SQL, applied in order
docs/          FakePay contract
test/          unit/ and integration/ (Vitest)
```

## Design notes and limits

Decisions, their reasons, and open questions are in [NOTES.md](NOTES.md). The
main limits:

- Reconciliation runs as a batch from the CLI; webhooks do not trigger it. Each
  run replaces all results.
- A run loads every order into memory and inserts results one row at a time.
  This was not measured on large data.
- Orders that no payment matched are not in the exceptions report.
- Matching thresholds (72 h, 720 h, score 0.9, lead 0.05) are fixed in code and
  were chosen for the scenario, not tuned on real data.
- Only PYG and USD are supported.

## How it was built

The owner wrote the plan, the provider contract and the review rules. Most of
the code was written by AI coding agents (Claude Code, Codex, Antigravity)
under those rules, with every milestone reviewed before it was accepted. The
process log in [NOTES.md](NOTES.md) records who did what and what reviews found.

## License

[MIT](LICENSE)
