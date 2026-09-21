import { isCreditDenialCode } from '../../shared/billing/credit-eligibility';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { OrdersRepository } from '../../infrastructure/database/repositories/orders.repository';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { assertOrganizationWriteAllowed } from '../auth/organization-role';
import { PhoneService } from '../../shared/services/phone.service';
import { InvalidPhoneNumberError } from '../../shared/errors/invalid-phone-number.error';
import {
  classifyCodStatus,
  collectPaymentSignals,
} from '../../shared/commerce/payment-signals';
import { BillingEntitlementService } from '../verification-core/billing-entitlement.service';
import { CreditEligibilityService } from '../verification-core/credit-eligibility.service';
import { WebhookDispatchService } from '../webhook-queue/webhook-dispatch.service';
import { buildBackendLog } from '../../shared/logging/backend-log.util';
import { StandaloneOrderIngestionService } from '../order-ingestion/standalone-order-ingestion.service';
import { MANUAL_ORDER_SOURCE_CODES } from '../order-ingestion/standalone-source-resolver';
import { ManualOrderChannelAdapter } from './manual-order.channel-adapter';
import { normalizeIdempotencyKey } from '../../shared/validation/idempotency-key';
import type {
  CreateManualOrderDto,
  CreateManualOrderResponseDto,
} from './dto/create-manual-order.dto';
import type {
  RetryGuardStateDto,
  RetryManualOrderVerificationResponseDto,
} from './dto/dashboard.dto';
import { WebhookEventsRepository } from '../../infrastructure/database/repositories/webhook-events.repository';
import { OrderEligibilityService } from '../verification-core/order-eligibility.service';
import { integrations } from '../../infrastructure/database/schema';

/**
 * The codes the manual endpoint has always answered a bad Idempotency-Key
 * with. The format itself is shared; only these names are per-channel, so
 * existing clients keep switching on the same values.
 */
const MANUAL_ORDER_IDEMPOTENCY_CODES = {
  required: 'MANUAL_ORDER_IDEMPOTENCY_KEY_REQUIRED',
  invalid: 'MANUAL_ORDER_VALIDATION_FAILED',
};

/**
 * Payment signals captured when the order was ingested.
 *
 * Manual ingestion stores the canonical order under `rawPayload.order`; reading
 * them back keeps a retry's eligibility decision identical to the original
 * ingestion's, instead of re-deriving it from `paymentMethod` alone.
 */
function readStoredPaymentSignals(rawPayload: unknown): string[] {
  if (!rawPayload || typeof rawPayload !== 'object') return [];
  const order = (rawPayload as Record<string, unknown>).order;
  if (!order || typeof order !== 'object') return [];
  const signals = (order as Record<string, unknown>).paymentSignals;
  if (!Array.isArray(signals)) return [];
  return signals.filter(
    (signal): signal is string => typeof signal === 'string',
  );
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly ordersRepo: OrdersRepository,
    private readonly ingestion: StandaloneOrderIngestionService,
    private readonly phoneService: PhoneService,
    private readonly billingEntitlements: BillingEntitlementService,
    private readonly creditEligibility: CreditEligibilityService,
    private readonly dispatcher: WebhookDispatchService,
    private readonly webhookEvents: WebhookEventsRepository,
    private readonly orderEligibility: OrderEligibilityService,
  ) {}

  async createManualOrder(
    user: AuthenticatedUser,
    idempotencyHeader: string | undefined,
    payload: CreateManualOrderDto,
  ): Promise<CreateManualOrderResponseDto> {
    this.ingestion.assertWritableRole(user, MANUAL_ORDER_SOURCE_CODES);
    const idempotencyKey = normalizeIdempotencyKey(
      idempotencyHeader,
      MANUAL_ORDER_IDEMPOTENCY_CODES,
    );
    const customerPhone = this.normalizePhone(payload.customerPhone);
    const source = await this.ingestion.resolveWritableSource(
      user,
      MANUAL_ORDER_SOURCE_CODES,
    );
    const entitlement = this.billingEntitlements.evaluateAccess(source, {
      id: source.id,
      orgId: user.orgId,
    });
    if (!entitlement.allowed) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'An active Standalone entitlement is required.',
        code: 'MANUAL_ORDER_ENTITLEMENT_REQUIRED',
        reason: entitlement.reason,
      });
    }
    if (!source.isAutoVerifyEnabled) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'Enable automatic verification before creating an order.',
        code: 'MANUAL_ORDER_AUTO_VERIFY_DISABLED',
      });
    }
    await this.assertCreditEligible(source);
    // `evaluateAccess` above is a policy check and never reads usage, so a
    // source at its included limit passed every gate and was accepted with a
    // 202 whose verification the worker then silently skipped. The merchant had
    // no way to learn that from the response. The retry endpoint below already
    // makes this check; the create endpoint has to make it too.
    //
    // Advisory by design: the transactional truth still lives in the dispatch
    // claim, which is what actually reserves the slot.
    const availability = await this.billingEntitlements.hasAvailableSlot({
      id: source.id,
      orgId: user.orgId,
    });
    if (!availability.available) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message:
          availability.reason === 'plan_limit_reached'
            ? 'The included verifications for this period are used up.'
            : 'An active Standalone entitlement is required.',
        code: isCreditDenialCode(availability.reason)
          ? availability.reason
          : availability.reason === 'plan_limit_reached'
            ? 'MANUAL_ORDER_PLAN_LIMIT_REACHED'
            : 'MANUAL_ORDER_ENTITLEMENT_REQUIRED',
        reason: availability.reason,
        consumedCount: availability.consumedCount,
        includedLimit: availability.includedLimit,
      });
    }

    const accepted = await this.ingestion
      .acceptOne(
        { orgId: user.orgId, source },
        ManualOrderChannelAdapter.toCanonicalOrderInput(payload, {
          idempotencyKey,
          customerPhone,
        }),
        { channel: 'manual', idempotencyKey },
      )
      .catch((error: unknown) =>
        ManualOrderChannelAdapter.rethrowAsHttp(error),
      );
    return {
      orderId: accepted.orderId,
      ...(accepted.verificationId
        ? { verificationId: accepted.verificationId }
        : {}),
      status: 'accepted',
      duplicate: accepted.duplicate,
    };
  }

  /**
   * Re-dispatch the durable ingestion event for an order whose verification is
   * blocked on a merchant-resolvable reason.
   *
   * Platform-neutral by construction: both webhook-created and manually created
   * orders own a `webhook_events` row, and `resetForRedispatch` + `dispatchById`
   * carry no platform semantics. The lifecycle is read from the same SQL
   * projection the dashboard renders, so the merchant is never offered a retry
   * the table does not show.
   */
  async retryOrderVerification(
    user: AuthenticatedUser,
    orderId: string,
  ): Promise<RetryManualOrderVerificationResponseDto> {
    assertOrganizationWriteAllowed(user.role, {
      code: 'MANUAL_ORDER_RETRY_ROLE_REQUIRED',
      message: 'Owner or admin role is required to retry verification.',
    });
    const order = await this.ordersRepo.findById(orderId);
    if (!order || order.orgId !== user.orgId) {
      throw new NotFoundException({
        code: 'MANUAL_ORDER_NOT_FOUND',
        message: 'Manual order not found.',
      });
    }
    const integration = order.integration;
    if (!integration) {
      throw new ConflictException({
        code: 'MANUAL_ORDER_RETRY_STATE_INVALID',
        message: 'The order is not linked to a commerce source.',
      });
    }
    const projected = await this.ordersRepo.findDashboardOrderById(
      orderId,
      user.orgId,
    );
    const lifecycle: RetryGuardStateDto = {
      status: (projected?.retryGuardStatus ??
        'accepted') as RetryGuardStateDto['status'],
      reason: projected?.retryGuardReason ?? null,
      verification_id: projected?.verificationId ?? null,
      retryable: projected?.retryGuardRetryable ?? false,
    };
    if (lifecycle.status === 'review_required') {
      throw new ConflictException({
        code: 'MANUAL_ORDER_RETRY_REVIEW_REQUIRED',
        message: 'Provider outcome must be reviewed before retrying.',
        lifecycle,
      });
    }
    if (['accepted', 'processing', 'pending'].includes(lifecycle.status)) {
      return {
        orderId,
        ...(lifecycle.verification_id
          ? { verificationId: lifecycle.verification_id }
          : {}),
        lifecycle,
        duplicate: true,
      };
    }
    if (!lifecycle.retryable) {
      throw new ConflictException({
        code: 'MANUAL_ORDER_RETRY_NOT_ALLOWED',
        message: 'This order lifecycle cannot be retried.',
        lifecycle,
      });
    }
    const readinessReason = this.retryReadinessReason(order, integration);
    if (readinessReason) {
      throw new ConflictException({
        code: 'MANUAL_ORDER_RETRY_BLOCKED',
        message: 'The Standalone source is not ready for verification.',
        reason: readinessReason,
        lifecycle,
      });
    }
    await this.assertCreditEligible(integration);
    const availability = await this.billingEntitlements.hasAvailableSlot({
      id: integration.id,
      orgId: integration.orgId,
    });
    if (!availability.available) {
      throw new ConflictException({
        code: isCreditDenialCode(availability.reason)
          ? availability.reason
          : 'MANUAL_ORDER_RETRY_BLOCKED',
        message: 'Verification entitlement is not currently available.',
        reason: availability.reason,
        lifecycle,
      });
    }
    const event = order.webhookEvents.find(
      (candidate) => candidate.jobType === 'order.create',
    );
    if (!event) {
      throw new ConflictException({
        code: 'MANUAL_ORDER_RETRY_STATE_INVALID',
        message: 'The durable processing event is missing.',
      });
    }
    const reset = await this.webhookEvents.resetForRedispatch({
      id: event.id,
      orderId: order.id,
    });
    if (reset) {
      const outcome = await this.dispatcher.dispatchById(event.id);
      if (outcome !== 'dispatched') {
        this.logger.error(
          buildBackendLog(OrdersService.name, {
            action: 'manual-order-retry-dispatch',
            outcome: 'failure',
            reason: outcome,
            orgId: user.orgId,
            integrationId: integration.id,
            orderId: order.id,
            webhookEventId: event.id,
          }),
        );
        throw new ServiceUnavailableException({
          statusCode: 503,
          error: 'Service Unavailable',
          message:
            'The verification could not be queued for retry. Retry safely.',
          code: 'MANUAL_ORDER_DISPATCH_FAILED',
        });
      }
    }
    return {
      orderId,
      ...(lifecycle.verification_id
        ? { verificationId: lifecycle.verification_id }
        : {}),
      lifecycle: {
        status: 'accepted',
        reason: null,
        verification_id: lifecycle.verification_id,
        retryable: false,
      },
      duplicate: !reset,
    };
  }

  /**
   * Read-only order and verification access stays open while credit is
   * unavailable; only the billable actions are refused.
   */
  private async assertCreditEligible(source: {
    orgId: string;
    platformType: string;
  }): Promise<void> {
    const denial = await this.creditEligibility.resolveDenial(source);
    if (!denial) return;
    throw new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      message: 'Credit is not available for this action.',
      code: denial,
      reason: denial,
    });
  }

  private normalizePhone(value: string): string {
    try {
      return this.phoneService.standardize(value);
    } catch (error) {
      if (!(error instanceof InvalidPhoneNumberError)) throw error;
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Manual order validation failed.',
        code: 'MANUAL_ORDER_VALIDATION_FAILED',
        fieldErrors: { customerPhone: error.message },
      });
    }
  }

  private retryReadinessReason(
    order: {
      orgId: string;
      integrationId: string;
      externalOrderId: string;
      orderNumber: string | null;
      customerPhone: string;
      customerName: string | null;
      totalPrice: string | null;
      currency: string | null;
      paymentMethod: string | null;
      rawPayload: unknown;
    },
    integration: typeof integrations.$inferSelect,
  ): string | null {
    if (!integration.isActive) return 'integration_inactive';
    if (integration.onboardingStatus !== 'completed')
      return 'onboarding_incomplete';
    if (!integration.isAutoVerifyEnabled) return 'auto_verify_disabled';
    const paymentSignals = collectPaymentSignals(
      readStoredPaymentSignals(order.rawPayload),
      order.paymentMethod ?? undefined,
    );
    const eligibility = this.orderEligibility.evaluateOrderForVerification({
      order: {
        orgId: order.orgId,
        integrationId: order.integrationId,
        externalOrderId: order.externalOrderId,
        orderNumber: order.orderNumber ?? undefined,
        customerPhone: order.customerPhone,
        customerName: order.customerName ?? undefined,
        totalPrice: order.totalPrice ?? '',
        currency: order.currency ?? '',
        paymentMethod: order.paymentMethod ?? '',
        paymentSignals,
        codStatus: classifyCodStatus(paymentSignals),
        rawPayload:
          order.rawPayload && typeof order.rawPayload === 'object'
            ? (order.rawPayload as Record<string, unknown>)
            : {},
      },
      integration,
    });
    return eligibility.eligible ? null : eligibility.reason;
  }
}
