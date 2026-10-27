import { isValidIanaTimezone } from '../../shared/utils/store-timezone.util';
import { AUTOMATION_TIMEZONES } from './dto/onboarding.dto';

export { isValidIanaTimezone };

/**
 * Quiet hours run in one of the curated MENA zones or in the store's own
 * Shopify zone, which can be anywhere. Anything else is rejected so a typo
 * cannot silently disable deferral (an unknown zone means "never quiet").
 */
export function isAllowedAutomationTimezone(
  value: string | null | undefined,
  shopTimezone: string | null | undefined,
): value is string {
  const tz = value?.trim();
  if (!tz) return false;
  if ((AUTOMATION_TIMEZONES as readonly string[]).includes(tz)) return true;
  return tz === shopTimezone?.trim() && isValidIanaTimezone(tz);
}
