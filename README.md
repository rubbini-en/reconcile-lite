<div align="center">

# reconcile-lite

**Match every payment to its order — and surface the ones that need a human.**

A TypeScript payment reconciliation service: signed webhooks in, staged matching,
exception reports out.

![Node.js 22](https://img.shields.io/badge/Node.js-22-339933?logo=nodedotjs&logoColor=white)
![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![PostgreSQL 17](https://img.shields.io/badge/PostgreSQL-17-4169E1?logo=postgresql&logoColor=white)
![Fastify 5](https://img.shields.io/badge/Fastify-5-000000?logo=fastify&logoColor=white)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)

</div>

---

## Why

Payment providers and order systems never agree perfectly. Webhooks arrive late,
twice, or out of order. Customers type references wrong. The same order gets paid
twice. A reconciliation service has to settle what it can with confidence and
hand everything else to a person, with enough context to act.

reconcile-lite does that against **FakePay**, a fictional provider with a
[fully specified webhook contract](docs/provider-contract.md).

## Highlights

- 🔐 **Verified webhooks.** HMAC-SHA256 over the raw body, constant-time
  comparison, and a 300-second replay window.
- 🔁 **Idempotent and order-independent.** Each event is stored once by ID.
  Payment state is rebuilt from all events, so a refund that arrives before its
  settlement is never lost.
- 🎯 **Staged matching.** Exact reference, then amount + currency + time window,
  then fuzzy matching on reference and customer name.
- 🚦 **Never guesses.** When two orders are equally good, the payment is marked
  `ambiguous` and left for a person.
- 📊 **Exception reports.** Markdown or CSV from the CLI, or JSON from a
  token-protected API. CSV output is safe to open in spreadsheets.
- 💰 **Exact money.** Integer minor units with a currency (PYG and USD), all
  times in UTC.
- 🧪 **Tested against real Postgres.** 353 unit and integration tests, plus a
  simulator that replays a full scenario over HTTP.

## How it works

```mermaid
flowchart LR
    FP[FakePay webhooks] -->|POST /webhooks/fakepay| IN[Verify + store event]
    IN --> PS[(Payment state)]
    CSV[Orders CSV] -->|npm run import:orders| OR[(Orders)]
    PS --> RC{npm run reconcile}
    OR --> RC
    RC --> RS[(Results)]
    RS --> MD[Markdown / CSV report]
    RS --> API[GET /exceptions]
```

Each settled payment goes through three matching stages. The first stage that
reaches a decision wins:

| Stage | Rule                                                                                                                 |
| ----- | -------------------------------------------------------------------------------------------------------------------- |
| 1     | Exact order reference                                                                                                |
| 2     | Same amount and currency, order created within ±72 h of settlement                                                   |
| 3     | Jaro-Winkler similarity on reference or customer name, within 720 h, score ≥ 0.9 and a clear lead over the runner-up |

Every payment ends with one status:

| Status            | Meaning                                                 |
| ----------------- | ------------------------------------------------------- |
| `matched`         | One order, same amount and currency                     |
| `ambiguous`       | Several orders fit equally well; a person decides       |
| `unmatched`       | No order fits                                           |
| `amount_mismatch` | The order was found, but the amount or currency differs |
| `duplicate`       | The order was already paid by an earlier payment        |
| `refunded`        | Fully refunded; partial refunds keep their status       |

## Quickstart

**Requirements:** Node.js 22 and Docker.

```sh
npm ci
docker compose up -d    # PostgreSQL 17 on 127.0.0.1:54329

export DATABASE_URL=postgres://reconcile:reconcile_local@127.0.0.1:54329/reconcile
export FAKEPAY_WEBHOOK_SECRET=$(openssl rand -hex 32)
export REPORT_API_TOKEN=$(openssl rand -hex 32)

npm run db:migrate
npm run build && npm start    # listening on http://127.0.0.1:3000
```

### See it in action

The simulator sends a fictional scenario that covers every status: shuffled,
with redeliveries, and with a refund that arrives before its settlement. In a
second terminal with the same variables:

```sh
npm run simulate -- --orders-out orders.csv --seed 1
npm run import:orders -- orders.csv
npm run reconcile
npm run report
```

```text
Sent 17 deliveries (17 attempts) to http://127.0.0.1:3000/webhooks/fakepay
  processed   14
  duplicate   3
Imported 10 new orders, 0 unchanged.
Reconciled 10 settled payments at 2026-10-14T11:20:57.418Z
  matched         5
  ambiguous       1
  unmatched       1
  amount_mismatch 1
  duplicate       1
  refunded        1
```

An excerpt of the report:

| Payment           | Amount    | Customer    | Order        | Detail                                                          |
| ----------------- | --------- | ----------- | ------------ | --------------------------------------------------------------- |
| pay_sim_ambiguous | 50000 PYG | -           | -            | stage amount_time_window; candidates ORD-SIM-1005, ORD-SIM-1015 |
| pay_sim_fuzzy     | 98000 PYG | Carla Roxas | ORD-SIM-1003 | stage fuzzy; confidence 0.964                                   |

## Configuration

| Variable                 | Required by         | Notes                        |
| ------------------------ | ------------------- | ---------------------------- |
| `DATABASE_URL`           | server and all CLIs | `postgres://` connection URL |
| `FAKEPAY_WEBHOOK_SECRET` | server, simulator   | at least 32 characters       |
| `REPORT_API_TOKEN`       | server              | at least 32 characters       |
| `PORT`                   | server              | optional, defaults to `3000` |

The server checks every variable at startup and lists all the problems it finds.
Error messages name the variable but never print its value.

## API

### `POST /webhooks/fakepay`

Receives FakePay events signed with a `FakePay-Signature: t=<unix>,v1=<hex>`
header.

| Response | When                                                   |
| -------- | ------------------------------------------------------ |
| `200`    | Event stored, or an identical redelivery               |
| `400`    | Invalid JSON, or the body breaks the contract          |
| `401`    | Signature missing, invalid, or outside the time window |
| `409`    | Same event ID received earlier with a different body   |

### `GET /exceptions`

Returns every payment that needs attention, as JSON.

```sh
curl -H "Authorization: Bearer $REPORT_API_TOKEN" \
  "http://127.0.0.1:3000/exceptions?day=2026-10-10"
```

- **`day`** is optional: a UTC date in `YYYY-MM-DD` format.
- **Responses:** `401` for a missing or wrong token, `400` for an invalid day.
  Responses are sent with `Cache-Control: no-store`.

## CLI

| Command                                                              | What it does                                                   |
| -------------------------------------------------------------------- | -------------------------------------------------------------- |
| `npm run db:migrate`                                                 | Apply SQL migrations in order                                  |
| `npm run import:orders -- <file.csv>`                                | Import orders. All-or-nothing; a repeat import changes nothing |
| `npm run reconcile`                                                  | Match all settled payments; one run at a time                  |
| `npm run report -- [--format md\|csv] [--day YYYY-MM-DD]`            | Print the exceptions report                                    |
| `npm run simulate -- --orders-out <file> [--url <url>] [--seed <n>]` | Replay the FakePay scenario; loopback URLs only                |

The orders CSV format:

```csv
order_ref,customer_name,amount,currency,created_at
ORD-1001,María Benítez,150000,PYG,2026-10-10T12:00:00Z
ORD-1002,"Acosta, Rodrigo",12.34,USD,2026-10-11T08:30:00Z
```

Amounts are in major units, and timestamps are ISO 8601 UTC ending in `Z`.

## Testing

```sh
npm test                    # unit + integration
npm run test:unit           # no database needed
npm run test:integration    # needs the Docker database
```

- **Integration tests** run against a real PostgreSQL database,
  `reconcile_test`, and reset its schema between tests. As a safeguard, the
  test helper refuses any database whose name doesn't end in `_test`.
- **The end-to-end test** sends the simulator's scenario through the real HTTP
  server. It checks that two different delivery orders end in the same state.
- **Other checks:** `npm run lint`, `npm run format:check`, `npm run typecheck`.
- **CI:** a GitHub Actions workflow in
  [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs all of these
  against a Postgres service container.

## Project structure

```
src/
├── webhooks/    signature, event schema, ingestion, route
├── payments/    payment state rebuilt from events
├── orders/      CSV validation, import, CLI
├── matching/    normalization, similarity, stages, engine
├── reconcile/   batch run and CLI
├── report/      exceptions query, Markdown/CSV rendering, route
├── simulator/   FakePay scenario and delivery
└── db/          connection pool and migration runner
migrations/      plain SQL migrations
docs/            FakePay provider contract
test/            unit and integration tests (Vitest)
```

## Design decisions

The reasoning behind each choice, along with the open questions, is in
[NOTES.md](NOTES.md). Some of the decisions:

- **Reconciliation runs as a batch.** Each run replaces all results inside one
  transaction, and a database lock allows only one run at a time.
- **Report results are versioned.** A result counts as outdated when its payment
  has changed since the run.
- **Partial refunds keep the match status.** Only a full refund sets `refunded`.

## Scope

reconcile-lite is a reference implementation built against a fictional
provider. Matching thresholds are fixed in code, only PYG and USD are
supported, and orders with no payment are not reported. It has not been
benchmarked on large datasets.

## Contributing

Every push must say whether CI should run. End the last commit message of each
pushed branch with a tag:

| Tag         | Effect                       | Use it for                     |
| ----------- | ---------------------------- | ------------------------------ |
| `[ci]`      | CI runs                      | code, tests, config, workflows |
| `[skip ci]` | GitHub Actions skips the run | docs and other non-code edits  |

```text
feat(report): add a currency column [ci]
docs: fix a typo in the quickstart [skip ci]
```

A `pre-push` hook in [`.githooks/`](.githooks/pre-push) rejects a push whose
branch tip has neither tag. `npm install` enables it by setting
`core.hooksPath`. Commits use [Conventional Commits](https://www.conventionalcommits.org/).

## License

[MIT](LICENSE) © 2026 Eduardo Rubbini
