import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InvalidPhoneNumberError } from '../../shared/errors/invalid-phone-number.error';
import { PhoneService } from '../../shared/services/phone.service';
import type { IdempotencyKeyCodes } from '../../shared/validation/idempotency-key';
import { normalizeOrderReference } from '../order-ingestion/standalone-ingestion-keys';
import {
  StandaloneIngestionAcceptanceError,
  StandaloneIngestionConflictError,
  StandaloneIngestionDispatchError,
} from '../order-ingestion/standalone-order-ingestion.errors';
import type {
  AcceptOneResult,
  CanonicalOrderExtras,
  CanonicalOrderInput,
} from '../order-ingestion/standalone-order-ingestion.types';
import type { StandaloneReadinessCodeMap } from '../order-ingestion/standalone-readiness-gate';
import type { StandaloneIntegrationSourceCodeMap } from '../order-ingestion/standalone-source-resolver';
import type {
  CreateApiOrderDto,
  CreateApiOrderResponseDto,
} from './dto/create-api-order.dto';

/**
 * A key is issued for one source. Whatever stops that source from being the
 * organization's single active Standalone source reads the same to an
 * integrator: the key's store cannot take orders.
 */
const SOURCE_UNAVAILABLE = {
  code: 'API_SOURCE_UNAVAILABLE',
  message: 'The store this API key belongs to cannot accept orders.',
};

export const API_ORDER_SOURCE_CODES: StandaloneIntegrationSourceCodeMap = {
  sourceUnavailable: SOURCE_UNAVAILABLE,
  sourceAmbiguous: SOURCE_UNAVAILABLE,
  sourceUnsupported: SOURCE_UNAVAILABLE,
  setupIncomplete: {
    code: 'API_SETUP_INCOMPLETE',
    message: 'Complete Standalone setup before submitting orders.',
  },
};

export const API_ORDER_READINESS_CODES: StandaloneReadinessCodeMap = {
  entitlementRequired: {
    code: 'API_ENTITLEMENT_REQUIRED',
    message: 'An active Standalone entitlement is required.',
  },
  autoVerifyDisabled: {
    code: 'API_AUTO_VERIFY_DISABLED',
    message: 'Enable automatic verification before submitting orders.',
  },
  planLimitReached: {
    code: 'API_PLAN_LIMIT_REACHED',
    message: 'The included verifications for this period are used up.',
  },
  setupIncomplete: API_ORDER_SOURCE_CODES.setupIncomplete,
};

export const API_ORDER_IDEMPOTENCY_CODES: IdempotencyKeyCodes = {
  required: 'API_VALIDATION_FAILED',
  invalid: 'API_VALIDATION_FAILED',
};

/** The one body every rejected field answers with. */
export function apiOrderValidationError(
  fieldErrors: Record<string, string>,
): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    message: 'Order validation failed.',
    code: 'API_VALIDATION_FAILED',
    fieldErrors,
  });
}

/**
 * Translates a server's order into the canonical Standalone order, and
 * ingestion outcomes back into the API's stable error codes.
 *
 * Translation only, like the manual form's and the file import's adapters: it
 * never writes, dispatches, checks credit or decides eligibility. Those belong
 * to `StandaloneOrderIngestionService`.
 */
@Injectable()
export class ApiOrderChannelAdapter {
  constructor(private readonly phoneService: PhoneService) {}

  toCanonicalOrderInput(dto: CreateApiOrderDto): CanonicalOrderInput {
    // The same identity a file import gives the merchant's reference, so an
    // order sent by both channels is one order.
    const externalOrderId = normalizeOrderReference(dto.externalOrderId);
    if (!externalOrderId) {
      throw apiOrderValidationError({
        externalOrderId: 'externalOrderId is required.',
      });
    }
    return {
      externalOrderId,
      orderNumber: dto.orderNumber ?? dto.externalOrderId,
      customerPhone: this.standardizePhone(dto.customerPhone),
      customerName: dto.customerName,
      totalPrice: dto.totalPrice,
      currency: dto.currency,
      paymentMethod: dto.paymentMethod,
      extras: extrasOf(dto),
    };
  }

  toResponse(accepted: AcceptOneResult): CreateApiOrderResponseDto {
    return {
      orderId: accepted.orderId,
      ...(accepted.verificationId
        ? { verificationId: accepted.verificationId }
        : {}),
      status: 'accepted',
      duplicate: accepted.duplicate,
    };
  }

  /** Rethrows an ingestion error as the API's response; others as-is. */
  rethrowAsHttp(error: unknown): never {
    if (error instanceof StandaloneIngestionConflictError) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'Idempotency-Key was already used with different order data.',
        code: 'API_ORDER_IDEMPOTENCY_CONFLICT',
      });
    }
    if (error instanceof StandaloneIngestionAcceptanceError) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        error: 'Service Unavailable',
        message:
          'The order could not be durably accepted. Retry with the same Idempotency-Key.',
        code: 'API_ORDER_ACCEPTANCE_FAILED',
      });
    }
    if (error instanceof StandaloneIngestionDispatchError) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        error: 'Service Unavailable',
        message:
          'The order was saved but its verification could not be queued. Retry with the same Idempotency-Key.',
        code: 'API_ORDER_DISPATCH_FAILED',
      });
    }
    throw error;
  }

  private standardizePhone(value: string): string {
    try {
      return this.phoneService.standardize(value);
    } catch (error) {
      if (!(error instanceof InvalidPhoneNumberError)) throw error;
      throw apiOrderValidationError({ customerPhone: error.message });
    }
  }
}

/** Only the keys the request actually filled; `undefined` would widen the fingerprint. */
function extrasOf(dto: CreateApiOrderDto): CanonicalOrderExtras {
  const extras: CanonicalOrderExtras = {};
  if (typeof dto.orderDate === 'string') extras.orderDate = dto.orderDate;
  if (typeof dto.city === 'string') extras.city = dto.city;
  if (typeof dto.address === 'string') extras.address = dto.address;
  if (typeof dto.notes === 'string') extras.notes = dto.notes;
  return extras;
}
