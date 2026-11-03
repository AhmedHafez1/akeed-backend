import type { WhatsappSignupPath } from '../../../database/schema';
import type {
  InspectedBusinessToken,
  WabaPhoneNumber,
} from './own-number-graph.client';

export const WHATSAPP_MANAGEMENT_SCOPE = 'whatsapp_business_management';
export const WHATSAPP_MESSAGING_SCOPE = 'whatsapp_business_messaging';

/**
 * What the signup page reported. Every field is a hint from the browser:
 * it narrows a choice among assets the token proves, and never adds one.
 */
export interface SignupSessionHints {
  /** v5 `messaging_account_ids`, v4 `waba_id`, and v4 `waba_ids`. */
  wabaIds: string[];
  phoneNumberId: string | null;
  /** v5 `is_on_biz_app`, or the `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` event. */
  isOnBusinessApp: boolean | null;
}

export type TokenCheck =
  | { ok: true }
  | { ok: false; reason: 'invalid' | 'app_mismatch' | 'missing_scope' };

/** The token must be live, issued to this app, and hold both WhatsApp scopes. */
export function checkBusinessToken(
  token: InspectedBusinessToken,
  appId: string,
): TokenCheck {
  if (!token.isValid) return { ok: false, reason: 'invalid' };
  if (token.appId !== appId) return { ok: false, reason: 'app_mismatch' };
  if (
    !token.scopes.includes(WHATSAPP_MANAGEMENT_SCOPE) ||
    !token.scopes.includes(WHATSAPP_MESSAGING_SCOPE)
  )
    return { ok: false, reason: 'missing_scope' };
  return { ok: true };
}

export type AssetChoice =
  | { ok: true; id: string }
  | { ok: false; reason: 'unverified' | 'ambiguous' };

function targetsOf(token: InspectedBusinessToken, scope: string): string[] {
  return [
    ...new Set(
      token.granularScopes
        .filter((entry) => entry.scope === scope)
        .flatMap((entry) => entry.targetIds),
    ),
  ];
}

/**
 * The WhatsApp Business account the token may both manage and message for.
 *
 * - Hinted accounts outside that set are refused: the browser cannot add one.
 * - One hinted account in the set is chosen.
 * - With no hint, the set must hold exactly one account.
 * - Anything else is ambiguous, and nothing is picked.
 */
export function chooseWabaId(
  token: InspectedBusinessToken,
  hints: SignupSessionHints,
): AssetChoice {
  const messaging = new Set(targetsOf(token, WHATSAPP_MESSAGING_SCOPE));
  const granted = targetsOf(token, WHATSAPP_MANAGEMENT_SCOPE).filter((id) =>
    messaging.has(id),
  );
  if (granted.length === 0) return { ok: false, reason: 'unverified' };

  const hinted = [...new Set(hints.wabaIds)];
  if (hinted.length > 0) {
    if (hinted.some((id) => !granted.includes(id)))
      return { ok: false, reason: 'unverified' };
    return hinted.length === 1
      ? { ok: true, id: hinted[0] }
      : { ok: false, reason: 'ambiguous' };
  }
  return granted.length === 1
    ? { ok: true, id: granted[0] }
    : { ok: false, reason: 'ambiguous' };
}

/**
 * The phone number, proven to belong to the chosen account by the account's
 * own list. A hinted number must be on it; with no hint the account must hold
 * exactly one.
 */
export function choosePhoneNumber(
  numbers: WabaPhoneNumber[],
  hintedPhoneNumberId: string | null,
):
  | { ok: true; phoneNumber: WabaPhoneNumber }
  | { ok: false; reason: 'unverified' | 'ambiguous' } {
  if (hintedPhoneNumberId) {
    const match = numbers.find((number) => number.id === hintedPhoneNumberId);
    return match
      ? { ok: true, phoneNumber: match }
      : { ok: false, reason: 'unverified' };
  }
  if (numbers.length === 0) return { ok: false, reason: 'unverified' };
  return numbers.length === 1
    ? { ok: true, phoneNumber: numbers[0] }
    : { ok: false, reason: 'ambiguous' };
}

/**
 * How the number was connected. Only the signup page reports this; no
 * documented Graph field confirms it. It is a label for later setup, never an
 * access decision.
 */
export function signupPathFromHints(
  hints: SignupSessionHints,
): WhatsappSignupPath {
  return hints.isOnBusinessApp === true ? 'coexistence' : 'new_number';
}
