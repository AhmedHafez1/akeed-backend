import { Injectable } from '@nestjs/common';
import {
  appendPaymentSignal,
  classifyCodStatus,
} from '../../../shared/commerce/payment-signals';
import type { PlatformType } from '../../../shared/interfaces/commerce-source.interface';
import type { NormalizedOrder } from '../../../shared/interfaces/order.interface';
import type { WebhookOrderNormalizer } from '../interfaces/webhook-normalizer.interface';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

@Injectable()
export class StandaloneManualOrderNormalizer implements WebhookOrderNormalizer {
  readonly platform: PlatformType = 'standalone';

  normalizeOrder(
    rawPayload: Record<string, unknown>,
    integrationId: string,
    orgId: string,
  ): NormalizedOrder | null {
    if (
      rawPayload.ingestionType !== 'manual' ||
      rawPayload.schemaVersion !== 1 ||
      typeof rawPayload.submissionFingerprint !== 'string' ||
      rawPayload.submissionFingerprint.trim() === '' ||
      !isRecord(rawPayload.order)
    ) {
      return null;
    }
    const order = rawPayload.order;
    const requiredStrings = [
      order.externalOrderId,
      order.customerPhone,
      order.totalPrice,
      order.currency,
    ];
    if (
      requiredStrings.some(
        (value) => typeof value !== 'string' || value.trim() === '',
      )
    ) {
      return null;
    }
    if (
      (order.orderNumber !== undefined &&
        order.orderNumber !== null &&
        typeof order.orderNumber !== 'string') ||
      (order.customerName !== undefined &&
        order.customerName !== null &&
        typeof order.customerName !== 'string')
    ) {
      return null;
    }
    if (
      order.paymentMethod !== undefined &&
      order.paymentMethod !== null &&
      typeof order.paymentMethod !== 'string'
    ) {
      return null;
    }
    const paymentSignals: string[] = [];
    appendPaymentSignal(
      paymentSignals,
      typeof order.paymentMethod === 'string' ? order.paymentMethod : undefined,
    );
    return {
      orgId,
      integrationId,
      externalOrderId: order.externalOrderId as string,
      orderNumber:
        typeof order.orderNumber === 'string' ? order.orderNumber : undefined,
      customerPhone: order.customerPhone as string,
      customerName:
        typeof order.customerName === 'string' ? order.customerName : undefined,
      totalPrice: order.totalPrice as string,
      currency: order.currency as string,
      paymentMethod:
        typeof order.paymentMethod === 'string' ? order.paymentMethod : '',
      paymentSignals,
      codStatus: classifyCodStatus(paymentSignals),
      rawPayload,
    };
  }
}
