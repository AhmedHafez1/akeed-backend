import {
  resolveTemplateMetricsRange,
  TEMPLATE_METRICS_MAX_RANGE_DAYS,
} from './admin-template-metrics.policy';

describe('resolveTemplateMetricsRange', () => {
  it('covers both days in UTC, whole', () => {
    expect(resolveTemplateMetricsRange('2026-09-01', '2026-09-30')).toEqual({
      ok: true,
      from: '2026-09-01T00:00:00.000Z',
      toExclusive: '2026-10-01T00:00:00.000Z',
      days: 30,
    });
  });

  it('accepts a single day', () => {
    expect(resolveTemplateMetricsRange('2026-09-15', '2026-09-15')).toEqual({
      ok: true,
      from: '2026-09-15T00:00:00.000Z',
      toExclusive: '2026-09-16T00:00:00.000Z',
      days: 1,
    });
  });

  it('accepts the longest range and refuses one day more', () => {
    expect(TEMPLATE_METRICS_MAX_RANGE_DAYS).toBe(92);
    // 1 July to 30 September is 92 days.
    expect(resolveTemplateMetricsRange('2026-07-01', '2026-09-30')).toEqual(
      expect.objectContaining({ ok: true, days: 92 }),
    );
    expect(resolveTemplateMetricsRange('2026-07-01', '2026-10-01')).toEqual({
      ok: false,
      problem: 'range_too_long',
    });
  });

  it('refuses a range that ends before it starts', () => {
    expect(resolveTemplateMetricsRange('2026-09-02', '2026-09-01')).toEqual({
      ok: false,
      problem: 'from_after_to',
    });
  });

  it.each([
    ['a missing value', ''],
    ['a date with a time', '2026-09-01T00:00:00.000Z'],
    ['another date format', '01/09/2026'],
    ['a day that does not exist', '2026-02-30'],
    ['a month that does not exist', '2026-13-01'],
    ['text', 'last-week'],
  ])('refuses %s', (_label, value) => {
    expect(resolveTemplateMetricsRange(value, '2026-09-30')).toEqual({
      ok: false,
      problem: 'invalid_date',
    });
    expect(resolveTemplateMetricsRange('2026-09-01', value)).toEqual({
      ok: false,
      problem: 'invalid_date',
    });
  });

  it('counts a leap day', () => {
    expect(resolveTemplateMetricsRange('2028-02-28', '2028-03-01')).toEqual(
      expect.objectContaining({ ok: true, days: 3 }),
    );
  });
});
