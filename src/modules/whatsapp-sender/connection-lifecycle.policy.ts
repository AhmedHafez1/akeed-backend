export const ACCOUNT_LIFECYCLE_EVENTS = new Set([
  'PARTNER_REMOVED',
  'PARTNER_APP_UNINSTALLED',
  'ACCOUNT_DELETED',
  'ACCOUNT_OFFBOARDED',
  'ACCOUNT_RECONNECTED',
  'ACCOUNT_RESTRICTION',
  'ACCOUNT_VIOLATION',
  'DISABLED_UPDATE',
]);

/** Provider reasons are identifiers, never arbitrary text copied into a log. */
export function lifecycleReason(event: string, reason: unknown): string {
  return event === 'PARTNER_REMOVED' &&
    typeof reason === 'string' &&
    /^[A-Z_]{1,64}$/.test(reason)
    ? reason
    : event;
}
