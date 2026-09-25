import {
  CANONICAL_COD_PAYMENT_METHOD,
  normalizeCanonicalPaymentMethod,
} from '../../../shared/commerce/canonical-order.rules';
import type { PaymentClassification } from '../mapping/mapping-rules';
import {
  classifyPaymentValue,
  normalizePaymentValue,
} from '../mapping/payment-value-classifier';

export interface CanonicalPayment {
  /** What the order carries, normalized exactly as the manual form does. */
  paymentMethod: string;
  /** The merchant's own text, kept when it was replaced by the COD constant. */
  paymentMethodOriginal?: string;
  /** The merchant said this value is not cash on delivery. */
  merchantNotCod: boolean;
}

/**
 * Chooses the canonical payment method only (AC6). Whether the order may be
 * confirmed is decided afterwards by the shared eligibility service.
 *
 * A value the merchant classified `cod` becomes the manual form's COD method;
 * any other value keeps its text. A blank cell uses this import's
 * `blankPaymentClass` when the merchant chose one, else stays blank so the
 * store's `assumeCodWhenPaymentMissing` setting applies. Values past the
 * listed 50 fall back to the automatic classification.
 */
export function canonicalPayment(
  cell: string,
  paymentValueMap: Readonly<Record<string, PaymentClassification>>,
  blankPaymentClass?: PaymentClassification,
): CanonicalPayment {
  const key = normalizePaymentValue(cell);
  const classification = !key
    ? blankPaymentClass
    : Object.hasOwn(paymentValueMap, key)
      ? paymentValueMap[key]
      : classifyPaymentValue(cell);
  if (classification === 'cod')
    return {
      paymentMethod: String(
        normalizeCanonicalPaymentMethod(CANONICAL_COD_PAYMENT_METHOD),
      ),
      ...(key ? { paymentMethodOriginal: cell } : {}),
      merchantNotCod: false,
    };
  return {
    paymentMethod: key ? String(normalizeCanonicalPaymentMethod(cell)) : '',
    merchantNotCod: classification === 'not_cod',
  };
}
