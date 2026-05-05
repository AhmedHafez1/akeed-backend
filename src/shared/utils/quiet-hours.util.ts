/**
 * Quiet-hours scheduling utility.
 *
 * Given a desired UTC due time, an integration timezone, and quiet-hours
 * configuration, returns an adjusted UTC due time that falls outside the
 * configured quiet window.
 *
 * Quiet hours are expressed in the integration's local time as `HH:mm`
 * strings (24-hour). Both same-day windows (e.g. `13:00`-`15:00`) and
 * cross-midnight windows (e.g. `21:00`-`09:00`) are supported.
 *
 * If quiet hours are disabled, malformed, or incomplete, the input
 * timestamp is returned unchanged.
 */

export interface QuietHoursConfig {
  enabled: boolean;
  start?: string | null;
  end?: string | null;
  timezone?: string | null;
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DEFAULT_TIMEZONE = 'Asia/Riyadh';
const MS_PER_MINUTE = 60_000;

/**
 * Parse `HH:mm` into total minutes from midnight, or `null` if malformed.
 */
function parseHHmm(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null;
  const match = TIME_RE.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours * 60 + minutes;
}

/**
 * Returns the wall-clock components in `timezone` for the given UTC date.
 */
function getZonedParts(
  date: Date,
  timezone: string,
): { year: number; month: number; day: number; hour: number; minute: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const lookup: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      lookup[part.type] = part.value;
    }
  }

  const hour = Number(lookup.hour) === 24 ? 0 : Number(lookup.hour);

  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    hour,
    minute: Number(lookup.minute),
  };
}

/**
 * Resolves the UTC offset (in minutes) that `timezone` has at the moment
 * represented by `date`. East-of-UTC zones return positive numbers.
 */
function getUtcOffsetMinutes(date: Date, timezone: string): number {
  const zoned = getZonedParts(date, timezone);
  const asUtc = Date.UTC(
    zoned.year,
    zoned.month - 1,
    zoned.day,
    zoned.hour,
    zoned.minute,
  );
  // The zoned wall-clock interpreted as UTC, minus the actual UTC time, is the
  // offset (rounded to whole minutes; quiet-hours config is minute-grained).
  return Math.round((asUtc - date.getTime()) / MS_PER_MINUTE);
}

/**
 * Convert a UTC timestamp into total minutes-from-local-midnight in `timezone`.
 */
function localMinutesOfDay(date: Date, timezone: string): number {
  const parts = getZonedParts(date, timezone);
  return parts.hour * 60 + parts.minute;
}

/**
 * Compute the UTC instant that corresponds to a specific wall-clock time on
 * the same local day as `date`.
 */
function utcForLocalTimeOnSameDay(
  date: Date,
  timezone: string,
  totalMinutes: number,
): Date {
  const parts = getZonedParts(date, timezone);
  const offsetMinutes = getUtcOffsetMinutes(date, timezone);
  // Wall-clock as if it were UTC minus the timezone offset gives true UTC.
  const wallClockAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    Math.floor(totalMinutes / 60),
    totalMinutes % 60,
  );
  return new Date(wallClockAsUtc - offsetMinutes * MS_PER_MINUTE);
}

/**
 * Returns true when `localMinutes` lies inside the (possibly cross-midnight)
 * window `[startMin, endMin)`. A degenerate window where start==end is treated
 * as empty (no quiet hours).
 */
function isInsideWindow(
  localMinutes: number,
  startMin: number,
  endMin: number,
): boolean {
  if (startMin === endMin) return false;
  if (startMin < endMin) {
    return localMinutes >= startMin && localMinutes < endMin;
  }
  // Cross-midnight: e.g. 21:00 - 09:00
  return localMinutes >= startMin || localMinutes < endMin;
}

/**
 * Returns the UTC instant of the next quiet-hours end boundary at or after
 * `from` (typically the input due time). Handles same-day and cross-midnight
 * windows.
 */
function computeNextWindowEnd(
  from: Date,
  timezone: string,
  startMin: number,
  endMin: number,
): Date {
  const localNow = localMinutesOfDay(from, timezone);
  const sameDayEnd = utcForLocalTimeOnSameDay(from, timezone, endMin);

  if (startMin < endMin) {
    // Same-day window: endpoint is later today (or already passed -> next day,
    // but that branch is irrelevant when localNow lies inside the window).
    if (localNow < endMin) return sameDayEnd;
    // Quiet window already ended today; not actually in window.
    return from;
  }

  // Cross-midnight window.
  if (localNow >= startMin) {
    // We are in the evening portion; end is tomorrow's `endMin`.
    return new Date(sameDayEnd.getTime() + 24 * 60 * MS_PER_MINUTE);
  }
  // We are in the early-morning portion; end is today's `endMin`.
  return sameDayEnd;
}

/**
 * Adjust a desired send time so it falls outside the merchant's quiet window.
 * Returns the original `dueAt` when the configuration is disabled or invalid.
 */
export function adjustForQuietHours(
  dueAt: Date,
  config: QuietHoursConfig,
): Date {
  if (!config.enabled) return dueAt;

  const startMin = parseHHmm(config.start);
  const endMin = parseHHmm(config.end);
  if (startMin === null || endMin === null) return dueAt;
  if (startMin === endMin) return dueAt;

  const timezone = config.timezone?.trim() || DEFAULT_TIMEZONE;

  let probe: Date;
  try {
    probe = new Date(dueAt.getTime());
    const localMinutes = localMinutesOfDay(probe, timezone);
    if (!isInsideWindow(localMinutes, startMin, endMin)) return dueAt;
    return computeNextWindowEnd(probe, timezone, startMin, endMin);
  } catch {
    // Unknown timezone or formatter failure: do not block sending.
    return dueAt;
  }
}

/**
 * Convenience helper for callers that only need to know whether `dueAt` is
 * currently inside the quiet window.
 */
export function isInsideQuietHours(
  dueAt: Date,
  config: QuietHoursConfig,
): boolean {
  if (!config.enabled) return false;
  const startMin = parseHHmm(config.start);
  const endMin = parseHHmm(config.end);
  if (startMin === null || endMin === null) return false;
  if (startMin === endMin) return false;

  const timezone = config.timezone?.trim() || DEFAULT_TIMEZONE;
  try {
    const localMinutes = localMinutesOfDay(dueAt, timezone);
    return isInsideWindow(localMinutes, startMin, endMin);
  } catch {
    return false;
  }
}
