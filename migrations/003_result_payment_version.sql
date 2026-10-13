-- The payments.updated_at value a reconcile run read for this result. The
-- report flags a result as outdated when the payment's value differs, which
-- compares one row with itself instead of two clocks (app and database). It
-- also catches a webhook that started before the run but committed after it.
-- Nullable because rows written before this migration did not record it; the
-- report treats NULL as outdated, and the next run replaces every row.
ALTER TABLE reconciliation_results
  ADD COLUMN payment_updated_at TIMESTAMPTZ;
