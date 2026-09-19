import { fitsCanonicalName } from '../../../shared/commerce/canonical-order.rules';
import type { FieldResult } from './phone';

const ANY_LETTER = /\p{L}/u;

/**
 * The customer name (AC3): first and last name joined when both are mapped,
 * the manual form's length limit, and at least one letter in any script.
 */
export function validateName(parts: readonly string[]): FieldResult<string> {
  const name = parts.filter(Boolean).join(' ');
  if (!name)
    return {
      ok: false,
      issue: { code: 'NAME_MISSING', field: 'customerName' },
    };
  if (!fitsCanonicalName(name))
    return {
      ok: false,
      issue: { code: 'NAME_TOO_LONG', field: 'customerName' },
    };
  if (!ANY_LETTER.test(name))
    return {
      ok: false,
      issue: { code: 'NAME_NOT_TEXT', field: 'customerName' },
    };
  return { ok: true, value: name };
}
