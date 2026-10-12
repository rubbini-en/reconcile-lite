-- Contract violations found while replaying a payment's events. Events are
-- stored and flagged, never rejected: rejection would depend on arrival order.
ALTER TABLE payments
  ADD COLUMN anomalies TEXT[] NOT NULL DEFAULT '{}'
  CONSTRAINT payments_known_anomalies CHECK (
    anomalies <@ ARRAY[
      'multiple_settlements',
      'conflicting_refund',
      'refund_currency_mismatch',
      'refunds_exceed_amount'
    ]::TEXT[]
  );
