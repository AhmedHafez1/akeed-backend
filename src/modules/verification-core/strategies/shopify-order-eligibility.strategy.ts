import { Injectable } from '@nestjs/common';
import { NormalizedOrder } from '../../../shared/interfaces/order.interface';
import { OrderEligibilityResult } from '../order-eligibility.types';
import { OrderEligibilityStrategy } from './order-eligibility.strategy';
import {
  appendPaymentSignal,
  isCashOnDeliveryPaymentSignal,
  normalizePaymentSignal,
} from '../../../shared/commerce/payment-signals';

@Injectable()
export class ShopifyOrderEligibilityStrategy implements OrderEligibilityStrategy {
  readonly platform = 'shopify';

  evaluateOrderForVerification(order: NormalizedOrder): OrderEligibilityResult {
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

    const paymentSignals = this.collectShopifyPaymentSignals(order);

    if (paymentSignals.length === 0) {
      return { eligible: false, reason: 'missing_payment_signal' };
    }

    const codSignal = paymentSignals.find((signal) =>
      isCashOnDeliveryPaymentSignal(signal),
    );

    if (codSignal) {
      return {
        eligible: true,
        reason: 'cod_match',
        matchedSignal: codSignal,
      };
    }

    return { eligible: false, reason: 'non_cod_payment_method' };
  }

  private collectShopifyPaymentSignals(order: NormalizedOrder): string[] {
    const signals: string[] = [];
    for (const signal of order.paymentSignals ?? []) {
      appendPaymentSignal(signals, signal);
    }
    appendPaymentSignal(signals, order.paymentMethod);

    const raw =
      order.rawPayload &&
      typeof order.rawPayload === 'object' &&
      !Array.isArray(order.rawPayload)
        ? order.rawPayload
        : null;

    if (!raw) {
      return signals;
    }

    const paymentGatewayNames = raw['payment_gateway_names'];
    if (Array.isArray(paymentGatewayNames)) {
      for (const gatewayName of paymentGatewayNames) {
        appendPaymentSignal(
          signals,
          typeof gatewayName === 'string' ? gatewayName : undefined,
        );
      }
    }

    appendPaymentSignal(
      signals,
      typeof raw['gateway'] === 'string' ? raw['gateway'] : undefined,
    );

    const transactions = raw['transactions'];
    if (Array.isArray(transactions)) {
      for (const transaction of transactions) {
        if (
          !transaction ||
          typeof transaction !== 'object' ||
          Array.isArray(transaction)
        ) {
          continue;
        }

        const gateway = (transaction as Record<string, unknown>)['gateway'];
        appendPaymentSignal(
          signals,
          typeof gateway === 'string' ? gateway : '',
        );
      }
    }

    return signals;
  }
}
