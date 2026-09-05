import type { DashboardDateRange } from '../dto/dashboard.dto';

interface LocalDateParts {
  year: number;
  month: number;
  day: number;
}

export function resolveDashboardTimezone(timezone?: string): string {
  const candidate = timezone?.trim() || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(
      new Date(0),
    );
    return candidate;
  } catch {
    return 'UTC';
  }
}

function localDateParts(date: Date, timezone: string): LocalDateParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
  };
}

function shiftLocalDate(parts: LocalDateParts, days: number): LocalDateParts {
  const shifted = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + days),
  );
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function compareLocalDates(
  left: LocalDateParts,
  right: LocalDateParts,
): number {
  return (
    Date.UTC(left.year, left.month - 1, left.day) -
    Date.UTC(right.year, right.month - 1, right.day)
  );
}

function utcForLocalDayStart(parts: LocalDateParts, timezone: string): Date {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day);
  let lower = target - 36 * 60 * 60 * 1000;
  let upper = target + 36 * 60 * 60 * 1000;

  // Find the first instant whose merchant-local date is the target date. This
  // stays correct across offset changes, including transitions at midnight.
  while (lower < upper) {
    const midpoint = Math.floor((lower + upper) / 2);
    const comparison = compareLocalDates(
      localDateParts(new Date(midpoint), timezone),
      parts,
    );
    if (comparison < 0) lower = midpoint + 1;
    else upper = midpoint;
  }

  return new Date(lower);
}

export function resolveDashboardDateRangeBounds(
  dateRange: DashboardDateRange,
  timezone: string,
  now = new Date(),
): { startAt: string; endAt: string } {
  const safeTimezone = resolveDashboardTimezone(timezone);

  const today = localDateParts(now, safeTimezone);
  const daysBack =
    dateRange === 'last_7_days'
      ? 6
      : dateRange === 'last_30_days'
        ? 29
        : dateRange === 'last_3_months'
          ? 89
          : 0;

  return {
    startAt: utcForLocalDayStart(
      shiftLocalDate(today, -daysBack),
      safeTimezone,
    ).toISOString(),
    endAt: utcForLocalDayStart(
      shiftLocalDate(today, 1),
      safeTimezone,
    ).toISOString(),
  };
}
