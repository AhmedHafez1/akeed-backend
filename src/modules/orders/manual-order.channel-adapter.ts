import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { CanonicalOrderInput } from '../../shared/commerce/standalone-order-envelope';
import {
  StandaloneIngestionAcceptanceError,
  StandaloneIngestionConflictError,
  StandaloneIngestionDispatchError,
} from '../order-ingestion/standalone-order-ingestion.errors';
import type { CreateManualOrderDto } from './dto/create-manual-order.dto';

/**
 * Translates the manual order form into the canonical Standalone order, and
 * ingestion outcomes back into the manual endpoint's stable error codes.
 *
 * Translation only: it never writes, dispatches or checks credit. Those
 * belong to `StandaloneOrderIngestionService`.
 */
export const ManualOrderChannelAdapter = {
  toCanonicalOrderInput(
    dto: CreateManualOrderDto,
    trusted: { idempotencyKey: string; customerPhone: string },
  ): CanonicalOrderInput {
    return {
      externalOrderId: manualExternalOrderId(trusted.idempotencyKey),
      orderNumber: dto.orderNumber,
      customerPhone: trusted.customerPhone,
      customerName: dto.customerName,
      totalPrice: dto.totalPrice,
      currency: dto.currency,
      paymentMethod: dto.paymentMethod,
    };
  },

  /** Rethrows an ingestion error as the manual endpoint's response; others as-is. */
  rethrowAsHttp(error: unknown): never {
    if (error instanceof StandaloneIngestionConflictError) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'Idempotency-Key was already used with different order data.',
        code: 'MANUAL_ORDER_IDEMPOTENCY_CONFLICT',
      });
    }
    if (error instanceof StandaloneIngestionAcceptanceError) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        error: 'Service Unavailable',
        message: 'The order could not be durably accepted. Retry safely.',
        code: 'MANUAL_ORDER_ACCEPTANCE_FAILED',
      });
    }
    if (error instanceof StandaloneIngestionDispatchError) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        error: 'Service Unavailable',
        message:
          'The order was saved but its verification could not be queued. Retry safely.',
        code: 'MANUAL_ORDER_DISPATCH_FAILED',
      });
    }
    throw error;
  },
};

/**
 * A manual order has no merchant reference guaranteed unique, so its identity
 * is derived from the submission's Idempotency-Key. Unchanged since manual
 * orders shipped: stored orders are matched by it on replay.
 */
function manualExternalOrderId(idempotencyKey: string): string {
  return `manual-${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 40)}`;
}
