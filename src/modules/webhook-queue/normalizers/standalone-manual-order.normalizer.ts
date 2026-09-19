import { Injectable, Logger } from '@nestjs/common';
import { buildBackendLog } from '../../../shared/logging/backend-log.util';
import {
  classifyCodStatus,
  collectPaymentSignals,
} from '../../../shared/commerce/payment-signals';
import {
  CANONICAL_ORDER_REQUIRED_FIELDS,
  isStandaloneIngestionChannel,
  STANDALONE_ENVELOPE_SCHEMA_VERSION,
} from '../../../shared/commerce/standalone-order-envelope';
import type { PlatformType } from '../../../shared/interfaces/commerce-source.interface';
import type { NormalizedOrder } from '../../../shared/interfaces/order.interface';
import type { WebhookOrderNormalizer } from '../interfaces/webhook-normalizer.interface';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

@Injectable()
export class StandaloneManualOrderNormalizer implements WebhookOrderNormalizer {
  readonly platform: PlatformType = 'standalone';

  private readonly logger = new Logger(StandaloneManualOrderNormalizer.name);

  normalizeOrder(
    rawPayload: Record<string, unknown>,
    integrationId: string,
    orgId: string,
  ): NormalizedOrder | null {
    // Any Standalone channel is accepted; the channel is audit metadata and
    // nothing below this check may depend on it.
    if (
      !isStandaloneIngestionChannel(rawPayload.ingestionType) ||
      rawPayload.schemaVersion !== STANDALONE_ENVELOPE_SCHEMA_VERSION ||
      typeof rawPayload.submissionFingerprint !== 'string' ||
      rawPayload.submissionFingerprint.trim() === '' ||
      !isRecord(rawPayload.order)
    ) {
      return this.reject(orgId, integrationId, 'invalid_envelope');
    }
    const order = rawPayload.order;
    // `orderNumber` and `customerName` moved up from the optional block. They
    // are what the customer's message is built from, so an envelope missing
    // either one has nothing worth sending and must not reach the send path.
    if (
      CANONICAL_ORDER_REQUIRED_FIELDS.some((field) => {
        const value = order[field];
        return typeof value !== 'string' || value.trim() === '';
      })
    ) {
      return this.reject(orgId, integrationId, 'missing_required_field');
    }
    if (
      order.paymentMethod !== undefined &&
      order.paymentMethod !== null &&
      typeof order.paymentMethod !== 'string'
    ) {
      return this.reject(orgId, integrationId, 'invalid_payment_method_type');
    }
    const paymentSignals = collectPaymentSignals(
      undefined,
      typeof order.paymentMethod === 'string' ? order.paymentMethod : undefined,
    );
    return {
      orgId,
      integrationId,
      externalOrderId: order.externalOrderId as string,
      orderNumber: order.orderNumber as string,
      customerPhone: order.customerPhone as string,
      customerName: order.customerName as string,
      totalPrice: order.totalPrice as string,
      currency: order.currency as string,
      paymentMethod:
        typeof order.paymentMethod === 'string' ? order.paymentMethod : '',
      paymentSignals,
      codStatus: classifyCodStatus(paymentSignals),
      rawPayload,
    };
  }

  private reject(orgId: string, integrationId: string, reason: string): null {
    this.logger.warn(
      buildBackendLog(StandaloneManualOrderNormalizer.name, {
        action: 'normalizeOrder',
        outcome: 'skipped',
        orgId,
        integrationId,
        reason,
      }),
    );
    return null;
  }
}
