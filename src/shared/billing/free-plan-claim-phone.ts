import { createHmac } from 'node:crypto';

/**
 * The value a free-plan claim keeps for the merchant's WhatsApp number: a
 * keyed hash of its digits. The claim row outlives shop/redact, so it must not
 * hold the number; a plain hash would not do, since phone numbers are few
 * enough to reverse by brute force. Digits only, so `+20 100…` and `20100…`
 * claim as the same number.
 */
export function hashClaimPhone(phone: string, key: string): string | null {
  const digits = phone.replace(/\D/g, '');
  if (!digits) return null;
  return createHmac('sha256', key).update(digits).digest('hex');
}
