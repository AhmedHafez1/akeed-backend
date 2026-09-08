-- Refund usage reservations for dispatches that are already known to have
-- failed. New writes perform the same transition transactionally; this repair
-- brings existing counters and dispatch flags into the same invariant.
--
-- The temporary table freezes the exact refund set for both updates. Re-running
-- the migration is safe because refunded dispatches have usage_reserved=false
-- and therefore cannot enter the set again.

DO $$
DECLARE
  refunded_dispatch_count bigint;
  updated_usage_period_count bigint;
BEGIN
  CREATE TEMP TABLE refundable_verification_dispatch_usage
  ON COMMIT DROP
  AS
  SELECT
    dispatch.id,
    dispatch.integration_id,
    dispatch.usage_period_start
  FROM "public"."verification_message_dispatches" AS dispatch
  INNER JOIN "public"."integration_monthly_usage" AS usage
    ON usage.integration_id = dispatch.integration_id
    AND usage.period_start = dispatch.usage_period_start
  WHERE dispatch.usage_reserved = true
    AND dispatch.usage_period_start IS NOT NULL
    AND (
      dispatch.failed_at IS NOT NULL
      OR (
        dispatch.state = 'outcome_unknown'
        AND dispatch.last_error_code IN (
          'provider_exception',
          'missing_provider_message_id'
        )
      )
    );

  WITH refund_totals AS (
    SELECT
      integration_id,
      usage_period_start,
      count(*)::integer AS refund_count
    FROM refundable_verification_dispatch_usage
    GROUP BY integration_id, usage_period_start
  )
  UPDATE "public"."integration_monthly_usage" AS usage
  SET
    consumed_count = GREATEST(usage.consumed_count - refund.refund_count, 0),
    updated_at = now()
  FROM refund_totals AS refund
  WHERE usage.integration_id = refund.integration_id
    AND usage.period_start = refund.usage_period_start;

  GET DIAGNOSTICS updated_usage_period_count = ROW_COUNT;

  UPDATE "public"."verification_message_dispatches" AS dispatch
  SET
    usage_reserved = false,
    updated_at = now()
  FROM refundable_verification_dispatch_usage AS refundable
  WHERE dispatch.id = refundable.id;

  GET DIAGNOSTICS refunded_dispatch_count = ROW_COUNT;
  RAISE NOTICE 'Refunded % failed verification dispatch(es) across % usage period(s)',
    refunded_dispatch_count, updated_usage_period_count;
END $$;
