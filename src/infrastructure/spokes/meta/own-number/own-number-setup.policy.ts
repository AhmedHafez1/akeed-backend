import { randomInt } from 'node:crypto';
import type { WhatsappSignupPath } from '../../../database/schema';
import type { PhoneNumberStatus } from './own-number-graph.client';

/** Meta's value for a number registered on Cloud API. */
export const CLOUD_API_PLATFORM = 'CLOUD_API';

export type NumberPathDecision =
  /** A new number not yet on Cloud API: register it. */
  | { kind: 'register' }
  /** A new number Meta already shows on Cloud API: nothing to register. */
  | { kind: 'already_registered' }
  /** Used in the WhatsApp Business app too: registration is skipped. */
  | { kind: 'coexistence' }
  /** Not safe to go on without staff. */
  | { kind: 'refuse'; code: 'path_mismatch' | 'path_unverified' };

/**
 * How setup treats the number. The signup path comes from the browser, so it
 * is a hint and never enough to register on its own: Meta's own read must
 * agree. Meta documents `is_on_biz_app: true` with `platform_type: CLOUD_API`
 * as a number that uses both Cloud API and the Business app; such a number is
 * already registered, and `/register` is never called for it.
 *
 * - Registration needs the hint `new_number` and `is_on_biz_app === false`.
 * - A missing or unreadable `is_on_biz_app` refuses: guessing wrong could
 *   register a Business app number.
 * - The hint and Meta disagreeing refuses, whichever way round.
 */
export function decideNumberPath(
  hint: WhatsappSignupPath,
  status: Pick<PhoneNumberStatus, 'isOnBizApp' | 'platformType'>,
): NumberPathDecision {
  if (status.isOnBizApp === null)
    return { kind: 'refuse', code: 'path_unverified' };
  if (status.isOnBizApp) {
    if (hint !== 'coexistence')
      return { kind: 'refuse', code: 'path_mismatch' };
    return status.platformType === CLOUD_API_PLATFORM
      ? { kind: 'coexistence' }
      : { kind: 'refuse', code: 'path_unverified' };
  }
  if (hint !== 'new_number') return { kind: 'refuse', code: 'path_mismatch' };
  return status.platformType === CLOUD_API_PLATFORM
    ? { kind: 'already_registered' }
    : { kind: 'register' };
}

/**
 * A six-digit two-step verification PIN from the operating system's secure
 * random source. Meta makes the first registration's PIN the number's PIN.
 */
export function generateRegistrationPin(
  random: (max: number) => number = (max) => randomInt(max),
): string {
  return String(random(1_000_000)).padStart(6, '0');
}
