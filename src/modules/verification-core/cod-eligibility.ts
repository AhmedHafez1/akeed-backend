import {
  collectPaymentSignals,
  isCashOnDeliveryPaymentSignal,
  normalizePaymentSignal,
} from '../../shared/commerce/payment-signals';
import type { NormalizedOrder } from '../../shared/interfaces/order.interface';
import type { OrderEligibilityResult } from './order-eligibility.types';

export interface CodEligibilityOptions {
  /**
   * Treat an order carrying no payment signal at all as cash-on-delivery.
   *
   * A per-source merchant setting rather than a platform trait: a spoke passes
   * the value its platform honours. Sources that can always report a payment
   * method pass `false`, so a missing signal stays a data problem instead of
   * being silently assumed to be COD.
   */
  assumeCodWhenPaymentMissing?: boolean;
}

/**
 * The one cash-on-delivery decision table.
 *
 * Spokes decide *where* payment evidence comes from — a Shopify order carries
 * gateways and transactions in its raw payload, a manually created order
 * carries a single merchant-entered method. What that evidence *means* is
 * identical for every commerce source and is decided here, so two platforms can
 * never drift into judging the same order differently.
 */
export function resolveCodEligibility(
  signals: readonly string[],
  options: CodEligibilityOptions = {},
): OrderEligibilityResult {
  const matchedSignal = signals.find(isCashOnDeliveryPaymentSignal);
  if (matchedSignal) {
    return { eligible: true, reason: 'cod_match', matchedSignal };
  }

  if (signals.length > 0) {
    return { eligible: false, reason: 'non_cod_payment_method' };
  }

  if (options.assumeCodWhenPaymentMissing === true) {
    return { eligible: true, reason: 'merchant_cod_default' };
  }

  return { eligible: false, reason: 'missing_payment_signal' };
}

/**
 * Applies the explicit COD disposition a normalizer already resolved, if any.
 *
 * Returns `undefined` when the order carries no verdict and the signals must be
 * judged by {@link resolveCodEligibility}.
 */
export function resolveDeclaredCodStatus(
  order: NormalizedOrder,
): OrderEligibilityResult | undefined {
  if (order.codStatus === 'cod') {
    const matchedSignal = order.paymentSignals
      ?.map(normalizePaymentSignal)
      .find(isCashOnDeliveryPaymentSignal);
    return {
      eligible: true,
      reason: 'cod_match',
      ...(matchedSignal ? { matchedSignal } : {}),
    };
  }
  if (order.codStatus === 'non_cod') {
    return { eligible: false, reason: 'non_cod_payment_method' };
  }
  return undefined;
}

/** Payment signals carried on the normalized order itself. */
export function collectNormalizedPaymentSignals(
  order: NormalizedOrder,
): string[] {
  return collectPaymentSignals(order.paymentSignals, order.paymentMethod);
}
