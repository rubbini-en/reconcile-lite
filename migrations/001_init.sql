-- All timestamps are TIMESTAMPTZ and written in UTC.
-- Money is BIGINT minor units plus an ISO-4217 code; never a decimal or float.

CREATE TABLE webhook_events (
  id                  BIGSERIAL PRIMARY KEY,
  provider_event_id   TEXT        NOT NULL UNIQUE,  -- idempotency key
  event_type          TEXT        NOT NULL CHECK (event_type IN ('payment.settled', 'payment.refunded')),
  provider_payment_id TEXT        NOT NULL,
  occurred_at         TIMESTAMPTZ NOT NULL,
  -- Exact signed bytes. jsonb normalizes whitespace and key order, so it cannot
  -- prove what was signed; the parsed copy below is for querying only.
  raw_body            TEXT        NOT NULL,
  body_sha256         CHAR(64)    NOT NULL,
  payload             JSONB       NOT NULL,
  received_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Payment state is rebuilt by replaying its events in this order.
CREATE INDEX webhook_events_payment_replay_idx
  ON webhook_events (provider_payment_id, occurred_at, id);

-- Current state of each FakePay payment, derived from webhook_events.
-- A payment can exist before settlement when a refund arrives first; its
-- settlement fields stay NULL until the payment.settled event is received.
CREATE TABLE payments (
  id                  BIGSERIAL PRIMARY KEY,
  provider_payment_id TEXT        NOT NULL UNIQUE,
  amount_minor        BIGINT      CHECK (amount_minor > 0),
  currency            CHAR(3)     CHECK (currency ~ '^[A-Z]{3}$'),
  reference           TEXT,
  customer_name       TEXT,
  settled_at          TIMESTAMPTZ,
  refunded_minor      BIGINT      NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payments_settlement_fields_together CHECK (
    (settled_at IS NULL AND amount_minor IS NULL AND currency IS NULL)
    OR (settled_at IS NOT NULL AND amount_minor IS NOT NULL AND currency IS NOT NULL)
  )
);

CREATE TABLE orders (
  id            BIGSERIAL PRIMARY KEY,
  order_ref     TEXT        NOT NULL UNIQUE,
  customer_name TEXT        NOT NULL,
  amount_minor  BIGINT      NOT NULL CHECK (amount_minor > 0),
  currency      CHAR(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at    TIMESTAMPTZ NOT NULL,
  imported_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX orders_currency_amount_created_idx
  ON orders (currency, amount_minor, created_at);

CREATE TYPE reconciliation_status AS ENUM (
  'matched', 'ambiguous', 'unmatched', 'amount_mismatch', 'duplicate', 'refunded'
);

CREATE TYPE match_stage AS ENUM ('exact_reference', 'amount_time_window', 'fuzzy');

-- Latest reconciliation outcome per payment. A rerun replaces the row.
CREATE TABLE reconciliation_results (
  payment_id          BIGINT                PRIMARY KEY REFERENCES payments (id),
  status              reconciliation_status NOT NULL,
  order_id            BIGINT                REFERENCES orders (id),
  stage               match_stage,
  confidence          NUMERIC(4, 3)         CHECK (confidence BETWEEN 0 AND 1),
  candidate_order_ids BIGINT[]              NOT NULL DEFAULT '{}',
  reconciled_at       TIMESTAMPTZ           NOT NULL,
  CONSTRAINT reconciliation_results_order_by_status CHECK (
    CASE status
      WHEN 'matched'         THEN order_id IS NOT NULL AND stage IS NOT NULL
      WHEN 'amount_mismatch' THEN order_id IS NOT NULL
      WHEN 'duplicate'       THEN order_id IS NOT NULL
      WHEN 'unmatched'       THEN order_id IS NULL
      -- Ambiguous cases are never auto-resolved: no order, at least two candidates.
      WHEN 'ambiguous'       THEN order_id IS NULL AND cardinality(candidate_order_ids) >= 2
      -- A fully refunded payment keeps its matched order when it had one.
      WHEN 'refunded'        THEN TRUE
    END
  )
);

-- One order can be matched by at most one payment; later ones become duplicates.
CREATE UNIQUE INDEX reconciliation_results_one_match_per_order_idx
  ON reconciliation_results (order_id)
  WHERE status = 'matched';
