/** The `integrations.timezone` column default; a store on it never chose a zone. */
export const DEFAULT_AUTOMATION_TIMEZONE = 'Asia/Riyadh';

/** True when the runtime can resolve `value` as an IANA time zone. */
export function isValidIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * The quiet-hours zone to save when the platform reports the store's zone, or
 * null to keep the saved one. A store still on the column default, or still on
 * the zone the platform reported before, follows the store; a zone the
 * merchant picked is kept.
 */
export function followStoreTimezone(params: {
  saved: string | null | undefined;
  previousStoreTimezone: string | null | undefined;
  storeTimezone: string | null | undefined;
}): string | null {
  const next = params.storeTimezone?.trim();
  if (!next || !isValidIanaTimezone(next)) return null;
  const saved = params.saved?.trim();
  if (saved === next) return null;
  const follows =
    !saved ||
    saved === DEFAULT_AUTOMATION_TIMEZONE ||
    saved === params.previousStoreTimezone?.trim();
  return follows ? next : null;
}
