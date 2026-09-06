/**
 * Maps a customer's reply to the verification outcome it expresses.
 *
 * Kept messaging-provider agnostic on purpose: a spoke hands over whatever the
 * customer produced — a quick-reply button payload or free text — and gets back
 * the neutral intent. A future provider (or a second WhatsApp BSP) reuses this
 * instead of restating the vocabulary.
 */
export type CustomerReplyIntent = 'confirmed' | 'canceled';

/** Payload prefixes Akeed sets on the template's quick-reply buttons. */
const CONFIRM_ACTIONS = new Set(['confirm', 'yes']);
const CANCEL_ACTIONS = new Set(['cancel', 'no']);

/**
 * Free-text answers accepted as a reply to the confirmation template.
 *
 * Arabic first — it is the default locale — then English, then the digits used
 * by customers whose keyboard makes either language awkward. Kept deliberately
 * tight: anything ambiguous must fall through to `null` so the verification is
 * left for the no-reply escalation rather than being resolved by a guess.
 */
const CONFIRM_TEXTS = new Set([
  'نعم',
  'نعم.',
  'اكد',
  'أكد',
  'تاكيد',
  'تأكيد',
  'موافق',
  'تمام',
  'yes',
  'y',
  'ok',
  'okay',
  'confirm',
  'confirmed',
  'accept',
  '1',
]);

const CANCEL_TEXTS = new Set([
  'لا',
  'لا.',
  'الغاء',
  'إلغاء',
  'الغى',
  'ألغي',
  'رفض',
  'no',
  'n',
  'cancel',
  'canceled',
  'cancelled',
  'reject',
  '2',
]);

/**
 * Normalizes for comparison: strips Arabic diacritics and the tatweel joiner,
 * collapses whitespace, and drops the trailing punctuation people add without
 * meaning anything by it.
 */
function normalizeReplyText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[ً-ْـ]/g, '')
    .replace(/[!؟?.،,]+$/u, '')
    .trim()
    .toLowerCase();
}

/**
 * Resolve a quick-reply button payload (`confirm_<verificationId>`).
 *
 * Returns the verification id alongside the intent because the payload is the
 * only place the id travels; a text reply has to be matched by context instead.
 */
export function resolveButtonPayload(
  payload: string,
): { intent: CustomerReplyIntent; verificationId: string } | null {
  // Exactly one separator. Verification ids are UUIDs and never contain an
  // underscore, so a payload with more segments than this did not come from a
  // template Akeed built — treating it as ours would let an arbitrary string
  // address a verification.
  const parts = payload.split('_');
  if (parts.length !== 2) return null;

  const action = parts[0].toLowerCase();
  const verificationId = parts[1].trim();
  if (!verificationId) return null;

  if (CONFIRM_ACTIONS.has(action))
    return { intent: 'confirmed', verificationId };
  if (CANCEL_ACTIONS.has(action)) return { intent: 'canceled', verificationId };
  return null;
}

/** Resolve a free-text reply. Returns `null` for anything not clearly one or the other. */
export function resolveReplyText(body: string): CustomerReplyIntent | null {
  const normalized = normalizeReplyText(body);
  if (!normalized) return null;
  if (CONFIRM_TEXTS.has(normalized)) return 'confirmed';
  if (CANCEL_TEXTS.has(normalized)) return 'canceled';
  return null;
}
