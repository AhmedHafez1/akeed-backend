import { Injectable } from '@nestjs/common';
import { NormalizedOrder } from '../../../interfaces/order.interface';
import { OrderEligibilityResult } from '../../order-eligibility.types';
import { OrderEligibilityStrategy } from '../order-eligibility.strategy';

@Injectable()
export class ShopifyOrderEligibilityStrategy implements OrderEligibilityStrategy {
  readonly platform = 'shopify';

  private readonly codMatchers: RegExp[] = [
    /\bcod\b/i,
    /\bcash\s*on\s*delivery\b/i,
    /\bcash\s*on\s*receipt\b/i,
    /\bcollect\s*on\s*delivery\b/i,
    /\bpay\s*on\s*delivery\b/i,
    /\u0627\u0644\u062f\u0641\u0639\s*\u0639\u0646\u062f\s*\u0627\u0644\u0627\u0633\u062a\u0644\u0627\u0645/i,
    /\u0643\u0627\u0634\s*\u0639\u0646\u062f\s*\u0627\u0644\u0627\u0633\u062a\u0644\u0627\u0645/i,
  ];

  evaluateOrderForVerification(order: NormalizedOrder): OrderEligibilityResult {
    const paymentSignals = this.collectShopifyPaymentSignals(order);

    if (paymentSignals.length === 0) {
      return { eligible: false, reason: 'missing_payment_signal' };
    }

    const codSignal = paymentSignals.find((signal) =>
      this.isCashOnDeliveryPaymentSignal(signal),
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
    this.pushSignal(signals, order.paymentMethod);

    const raw =
      order.rawPayload &&
      typeof order.rawPayload === 'object' &&
      !Array.isArray(order.rawPayload)
        ? (order.rawPayload as Record<string, unknown>)
        : null;

    if (!raw) {
      return signals;
    }

    const paymentGatewayNames = raw['payment_gateway_names'];
    if (Array.isArray(paymentGatewayNames)) {
      for (const gatewayName of paymentGatewayNames) {
        this.pushSignal(
          signals,
          typeof gatewayName === 'string' ? gatewayName : undefined,
        );
      }
    }

    this.pushSignal(
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
        this.pushSignal(signals, typeof gateway === 'string' ? gateway : '');
      }
    }

    return signals;
  }

  private isCashOnDeliveryPaymentSignal(signal: string): boolean {
    const normalizedSignal = this.normalizePaymentSignal(signal);
    return this.codMatchers.some((matcher) => matcher.test(normalizedSignal));
  }

  private pushSignal(target: string[], value?: string): void {
    if (!value) {
      return;
    }

    const normalized = this.normalizePaymentSignal(value);
    if (!normalized || target.includes(normalized)) {
      return;
    }

    target.push(normalized);
  }

  private normalizePaymentSignal(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ');
  }
}
