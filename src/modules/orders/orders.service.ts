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
import { StandaloneSendReadinessService } from '../order-ingestion/standalone-send-readiness.service';
import type { SendReadinessBlocker } from '../order-ingestion/standalone-send-readiness.types';

/**
 * The codes the manual endpoint has always answered a bad Idempotency-Key
 * with. The format itself is shared; only these names are per-channel, so
 * existing clients keep switching on the same values.
 */
const MANUAL_ORDER_IDEMPOTENCY_CODES = {
  required: 'MANUAL_ORDER_IDEMPOTENCY_KEY_REQUIRED',
  invalid: 'MANUAL_ORDER_VALIDATION_FAILED',
};

/** The first readiness blocker of `kind`, typed. */
function blockerOf<K extends SendReadinessBlocker['kind']>(
  blockers: SendReadinessBlocker[],
  kind: K,
): Extract<SendReadinessBlocker, { kind: K }> | undefined {
  return blockers.find(
    (blocker): blocker is Extract<SendReadinessBlocker, { kind: K }> =>
      blocker.kind === kind,
  );
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly ordersRepo: OrdersRepository,
    private readonly ingestion: StandaloneOrderIngestionService,
    private readonly phoneService: PhoneService,
    private readonly readiness: StandaloneSendReadinessService,
    private readonly dispatcher: WebhookDispatchService,
    private readonly webhookEvents: WebhookEventsRepository,
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
    const readiness = await this.readiness.evaluate(source, { required: 1 });
    this.assertManualCreateReady(readiness.blockers);

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
    const readiness = await this.readiness.evaluate(integration, {
      required: 1,
      order,
    });
    this.assertRetryReady(readiness.blockers, lifecycle);
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
   * The manual create endpoint's answer to each readiness blocker. The rules
   * live in `StandaloneSendReadinessService`; this is only the vocabulary and
   * precedence the manual form has always answered with.
   *
   * Read-only order and verification access stays open while credit is
   * unavailable; only the billable actions are refused.
   */
  private assertManualCreateReady(blockers: SendReadinessBlocker[]): void {
    if (blockers.length === 0) return;
    const entitlement = blockerOf(blockers, 'entitlement_required');
    if (entitlement) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'An active Standalone entitlement is required.',
        code: 'MANUAL_ORDER_ENTITLEMENT_REQUIRED',
        reason: entitlement.reason,
      });
    }
    if (blockerOf(blockers, 'auto_verify_disabled')) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'Enable automatic verification before creating an order.',
        code: 'MANUAL_ORDER_AUTO_VERIFY_DISABLED',
      });
    }
    const credit = blockerOf(blockers, 'credit_denied');
    if (credit) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'Credit is not available for this action.',
        code: credit.code,
        reason: credit.code,
      });
    }
    // The entitlement policy never reads usage, so a source at its included
    // limit passes it; without this the create answered 202 and the worker
    // silently skipped the verification. Advisory by design: the dispatch
    // claim is what actually reserves the slot.
    const slot = blockerOf(blockers, 'slot_unavailable');
    if (slot) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message:
          slot.reason === 'plan_limit_reached'
            ? 'The included verifications for this period are used up.'
            : 'An active Standalone entitlement is required.',
        code: isCreditDenialCode(slot.reason)
          ? slot.reason
          : slot.reason === 'plan_limit_reached'
            ? 'MANUAL_ORDER_PLAN_LIMIT_REACHED'
            : 'MANUAL_ORDER_ENTITLEMENT_REQUIRED',
        reason: slot.reason,
        consumedCount: slot.consumedCount,
        includedLimit: slot.includedLimit,
      });
    }
    // The source resolver already refused inactive and unfinished sources;
    // failing closed here keeps any future blocker from being accepted.
    throw new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      message: MANUAL_ORDER_SOURCE_CODES.setupIncomplete.message,
      code: MANUAL_ORDER_SOURCE_CODES.setupIncomplete.code,
    });
  }

  /** The retry endpoint's answer to each readiness blocker. */
  private assertRetryReady(
    blockers: SendReadinessBlocker[],
    lifecycle: RetryGuardStateDto,
  ): void {
    if (blockers.length === 0) return;
    const notReady = blockerOf(blockers, 'source_inactive')
      ? 'integration_inactive'
      : blockerOf(blockers, 'setup_incomplete')
        ? 'onboarding_incomplete'
        : blockerOf(blockers, 'auto_verify_disabled')
          ? 'auto_verify_disabled'
          : blockerOf(blockers, 'order_ineligible')?.reason;
    if (notReady) {
      throw new ConflictException({
        code: 'MANUAL_ORDER_RETRY_BLOCKED',
        message: 'The Standalone source is not ready for verification.',
        reason: notReady,
        lifecycle,
      });
    }
    const credit = blockerOf(blockers, 'credit_denied');
    if (credit) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'Credit is not available for this action.',
        code: credit.code,
        reason: credit.code,
      });
    }
    // Retry has always learned about a denied entitlement from the usage
    // read, so both answer with the same body.
    const slot = blockerOf(blockers, 'slot_unavailable');
    const reason =
      slot?.reason ?? blockerOf(blockers, 'entitlement_required')?.reason;
    throw new ConflictException({
      code: isCreditDenialCode(reason) ? reason : 'MANUAL_ORDER_RETRY_BLOCKED',
      message: 'Verification entitlement is not currently available.',
      reason: reason ?? null,
      lifecycle,
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
}
