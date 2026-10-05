export const TEMPLATE_METRICS_MAX_RANGE_DAYS = 92;

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export type TemplateMetricsRangeProblem =
  | 'invalid_date'
  | 'from_after_to'
  | 'range_too_long';

export type TemplateMetricsRange =
  | { ok: true; from: string; toExclusive: string; days: number }
  | { ok: false; problem: TemplateMetricsRangeProblem };

function startOfUtcDay(value: string): number | null {
  if (!DATE_ONLY.test(value)) return null;
  const instant = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(instant)) return null;
  // `Date.parse` rolls an impossible day over (02-30 becomes 03-02); only a
  // date that reads back as written is a real one.
  return new Date(instant).toISOString().slice(0, 10) === value
    ? instant
    : null;
}

/**
 * The range of sends a metrics request covers. Both ends are calendar days in
 * UTC and both are included, so the upper bound returned is the start of the
 * day after `to`.
 */
export function resolveTemplateMetricsRange(
  from: string,
  to: string,
): TemplateMetricsRange {
  const start = startOfUtcDay(from);
  const lastDay = startOfUtcDay(to);
  if (start === null || lastDay === null)
    return { ok: false, problem: 'invalid_date' };
  if (start > lastDay) return { ok: false, problem: 'from_after_to' };
  const days = Math.round((lastDay - start) / DAY_MS) + 1;
  if (days > TEMPLATE_METRICS_MAX_RANGE_DAYS)
    return { ok: false, problem: 'range_too_long' };
  return {
    ok: true,
    from: new Date(start).toISOString(),
    toExclusive: new Date(lastDay + DAY_MS).toISOString(),
    days,
  };
}
