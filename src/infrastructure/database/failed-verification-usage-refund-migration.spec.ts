import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('failed verification usage refund migration contract', () => {
  const sql = readFileSync(
    resolve(
      __dirname,
      '../../../drizzle/0031_refund_failed_verification_usage.sql',
    ),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('selects only identifiable reserved failures', () => {
    expect(sql).toContain('dispatch.usage_reserved = true');
    expect(sql).toContain('dispatch.usage_period_start IS NOT NULL');
    expect(sql).toContain('usage.period_start = dispatch.usage_period_start');
    expect(sql).toContain('dispatch.failed_at IS NOT NULL');
    expect(sql).toContain("dispatch.state = 'outcome_unknown'");
    expect(sql).toContain("'provider_exception'");
    expect(sql).toContain("'missing_provider_message_id'");
  });

  it('groups refunds by integration and original billing period', () => {
    expect(sql).toContain('GROUP BY integration_id, usage_period_start');
    expect(sql).toContain('usage.integration_id = refund.integration_id');
    expect(sql).toContain('usage.period_start = refund.usage_period_start');
  });

  it('cannot make a counter negative', () => {
    expect(sql).toContain(
      'consumed_count = GREATEST(usage.consumed_count - refund.refund_count, 0)',
    );
  });

  it('is idempotent and reports exactly what it changed', () => {
    expect(sql).toContain('usage_reserved = false');
    expect(sql).toContain(
      'GET DIAGNOSTICS refunded_dispatch_count = ROW_COUNT;',
    );
    expect(sql).toContain(
      'GET DIAGNOSTICS updated_usage_period_count = ROW_COUNT;',
    );
  });
});
