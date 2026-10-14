/**
 * How Akeed treats a provider's report that a confirmation message was not
 * delivered.
 *
 * `no_whatsapp`: the customer number cannot receive WhatsApp messages (Meta
 * error 131026: the number is not on WhatsApp, or its owner has not accepted
 * the current terms or runs an outdated app). The merchant should call the
 * customer; a resend would fail the same way.
 *
 * `other`: every other code keeps the generic delivery-failure handling.
 *
 * @see https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes
 */
export type DeliveryFailureClass = 'no_whatsapp' | 'other';

export const NO_WHATSAPP_ERROR_CODE = '131026';

/** The send-outcome reason when the provider refused the number outright. */
export const NO_WHATSAPP_SEND_REASON = 'no_whatsapp';

export function classifyDeliveryFailure(
  code: number | string | null | undefined,
): DeliveryFailureClass {
  if (code == null) return 'other';
  const normalized = typeof code === 'number' ? String(code) : code.trim();
  return normalized === NO_WHATSAPP_ERROR_CODE ? 'no_whatsapp' : 'other';
}

/** The provider error code as stored on the verification, or null. */
export function normalizeDeliveryErrorCode(
  code: number | string | null | undefined,
): string | null {
  if (typeof code === 'number') {
    return Number.isFinite(code) ? String(code) : null;
  }
  if (typeof code === 'string') {
    const trimmed = code.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}
