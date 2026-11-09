import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  VerificationChangeRequestsRepository,
  type ChangeRequestEffectRow,
  type ChangeRequestEventRow,
  type ChangeRequestRow,
} from '../../infrastructure/database/repositories/verification-change-requests.repository';
import { OrdersRepository } from '../../infrastructure/database/repositories/orders.repository';
import { VerificationAutoCancellationsRepository } from '../../infrastructure/database/repositories/verification-auto-cancellations.repository';
import { VerificationsRepository } from '../../infrastructure/database/repositories/verifications.repository';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { assertOrganizationWriteAllowed } from '../auth/organization-role';
import { ChangeRequestLifecycleService } from '../change-requests/change-request-lifecycle.service';
import { CommerceOutcomeRegistryService } from '../commerce-outcomes/commerce-outcome-registry.service';
import {
  ChangeRequestReconfirmationService,
  type ReconfirmationView,
} from '../verification-core/change-request-reconfirmation.service';
import { VerificationHubService } from '../verification-core/verification-hub.service';
import type { CommerceOutcomeOperationResult } from '../../shared/commerce/commerce-outcome';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import type { ChangeRequestEffectStatus } from '../../shared/verification/change-request.policy';

/** One step of a request's history, as the dashboard shows it. */
export interface ChangeRequestHistoryItem {
  event: ChangeRequestEventRow['event'];
  actor: ChangeRequestEventRow['actorKind'];
  /** The merchant user who acted, when one did. Never another tenant's. */
  actor_user_id: string | null;
  at: string;
  /** A resolution, a failure reason or an attempt; never customer data. */
  detail: {
    resolution?: string;
    reason?: string;
    attempt?: number;
    scheduled_for?: string;
  };
}

/** A change request as the dashboard reads it. */
export interface ChangeRequestView {
  id: string;
  verification_id: string;
  status: ChangeRequestRow['status'];
  resolution: ChangeRequestRow['resolution'];
  confirmation_cycle: number;
  opened_at: string;
  resolved_at: string | null;
  acknowledgment: {
    status: ChangeRequestEffectStatus | null;
    reason: string | null;
  };
  reconfirmation: {
    state: ChangeRequestRow['reconfirmationState'];
    scheduled_for: string | null;
    last_error: string | null;
  };
  history: ChangeRequestHistoryItem[];
  merchant_email: {
    status: ChangeRequestEffectStatus | null;
    reason: string | null;
  };
  platform_sync: {
    status: ChangeRequestEffectStatus | null;
    reason: string | null;
  };
}

export interface ChangeRequestResolutionResponse {
  success: true;
  verificationId: string;
  status: 'confirmed' | 'canceled';
  changeRequestId: string;
  /** The store's answer to a cancellation; the sync status is on the row. */
  operation?: CommerceOutcomeOperationResult;
}

function readDetail(detail: unknown): ChangeRequestHistoryItem['detail'] {
  if (!detail || typeof detail !== 'object') return {};
  const value = detail as Record<string, unknown>;
  return {
    ...(typeof value.resolution === 'string'
      ? { resolution: value.resolution }
      : {}),
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    ...(typeof value.attempt === 'number' ? { attempt: value.attempt } : {}),
    ...(typeof value.scheduledFor === 'string'
      ? { scheduled_for: value.scheduledFor }
      : {}),
  };
}

export function toChangeRequestView(
  request: ChangeRequestRow,
  history: ChangeRequestEventRow[],
  effects: ChangeRequestEffectRow[],
): ChangeRequestView {
  const ack = effects.find(
    (effect) => effect.kind === 'customer_acknowledgment',
  );
  const email = effects.find((effect) => effect.kind === 'merchant_email');
  const marker = effects.find(
    (effect) =>
      effect.kind ===
      (request.status === 'open'
        ? 'platform_marker_set'
        : 'platform_marker_clear'),
  );
  return {
    id: request.id,
    verification_id: request.verificationId,
    status: request.status,
    resolution: request.resolution ?? null,
    confirmation_cycle: request.confirmationCycle,
    opened_at: request.openedAt,
    resolved_at: request.resolvedAt ?? null,
    acknowledgment: {
      status: ack?.status ?? null,
      reason: ack?.reason ?? null,
    },
    merchant_email: {
      status: email?.status ?? null,
      reason: email?.reason ?? null,
    },
    platform_sync: {
      status: marker?.status ?? null,
      reason: marker?.reason ?? null,
    },
    reconfirmation: {
      state: request.reconfirmationState ?? null,
      scheduled_for: request.reconfirmationScheduledFor ?? null,
      last_error: request.lastReconfirmationError ?? null,
    },
    history: history.map((event) => ({
      event: event.event,
      actor: event.actorKind,
      actor_user_id: event.actorUserId ?? null,
      at: event.createdAt,
      detail: readDetail(event.detail),
    })),
  };
}

/**
 * The merchant's side of a customer change request: reading it, and the
 * three outcomes after contacting the customer. Every call is scoped by the
 * caller's organization, and every write needs the owner or admin role.
 *
 * The outcomes go through the existing paths: a confirmation through the
 * verification hub's outcome sync, a cancellation through the merchant
 * cancel action and its tagging, and an updated confirmation through the
 * normal send path. Each one re-checks the request under its lock, so an
 * outcome the customer already gave, or another tab's, is reported back
 * instead of being overwritten.
 */
@Injectable()
export class ChangeRequestMerchantService {
  private readonly logger = new Logger(ChangeRequestMerchantService.name);

  constructor(
    private readonly changeRequests: VerificationChangeRequestsRepository,
    private readonly lifecycle: ChangeRequestLifecycleService,
    private readonly reconfirmations: ChangeRequestReconfirmationService,
    private readonly hub: VerificationHubService,
    private readonly commerceOutcomes: CommerceOutcomeRegistryService,
    private readonly verificationsRepo: VerificationsRepository,
    private readonly ordersRepo: OrdersRepository,
    private readonly autoCancellations: VerificationAutoCancellationsRepository,
  ) {}

  /** The open request, or else the latest one, with its history. */
  async get(
    user: AuthenticatedUser,
    verificationId: string,
  ): Promise<{ change_request: ChangeRequestView | null }> {
    const verification = await this.verificationsRepo.findByIdForOrg(
      verificationId,
      user.orgId,
    );
    if (!verification || verification.orgId !== user.orgId)
      throw new NotFoundException({
        message: 'Verification not found',
        code: 'VERIFICATION_NOT_FOUND',
      });
    const [request] = await this.changeRequests.findByVerificationIds(
      user.orgId,
      [verificationId],
    );
    if (!request) return { change_request: null };
    const [history, effects] = await Promise.all([
      this.changeRequests.listHistory(request.id, user.orgId),
      this.changeRequests.listEffects(request.id, user.orgId),
    ]);
    return { change_request: toChangeRequestView(request, history, effects) };
  }

  /** "Confirmed after contacting customer". */
  async confirm(
    user: AuthenticatedUser,
    verificationId: string,
    changeRequestId: string,
  ): Promise<ChangeRequestResolutionResponse> {
    const result = await this.lifecycle.confirmAfterContact(
      user,
      verificationId,
      changeRequestId,
    );
    this.log('change-request-merchant-confirm', user.orgId, verificationId);
    // The store hears it exactly as it hears any manual confirmation, by the
    // merchant's outcome-sync settings; its sync state shows on the order.
    await this.hub.finalizeVerification(verificationId, 'confirmed');
    return {
      success: true,
      verificationId,
      status: 'confirmed',
      changeRequestId: result.request.id,
    };
  }

  /**
   * "Cancelled after contacting customer". The store is asked first, through
   * the merchant cancel action, and the order is recorded canceled only once
   * the store accepted; then it is tagged like any merchant cancellation.
   */
  async cancel(
    user: AuthenticatedUser,
    verificationId: string,
    changeRequestId: string,
  ): Promise<ChangeRequestResolutionResponse> {
    assertOrganizationWriteAllowed(user.role, {
      message: 'Owner or admin role is required to cancel an order.',
      code: 'VERIFICATION_ROLE_REQUIRED',
    });
    const orgId = user.orgId;
    const open = await this.lifecycle.assertMerchantActionable(
      user,
      verificationId,
    );
    if (open.id !== changeRequestId)
      throw new ConflictException({
        message: 'This change request was replaced by a newer one.',
        code: 'CHANGE_REQUEST_STALE',
      });
    const verification = await this.verificationsRepo.findByIdForOrg(
      verificationId,
      orgId,
    );
    const order = verification
      ? await this.ordersRepo.findById(verification.orderId)
      : undefined;
    if (
      !order ||
      order.orgId !== orgId ||
      !order.integration ||
      order.integration.orgId !== orgId ||
      order.integration.id !== order.integrationId ||
      !order.externalOrderId
    )
      throw new BadRequestException({
        message: 'Cannot cancel: the order has no usable source',
        code: 'CHANGE_REQUEST_ORDER_SOURCE_MISSING',
      });
    const autoCancel = await this.autoCancellations.findByVerification(
      verificationId,
      orgId,
    );
    if (VerificationAutoCancellationsRepository.isCommitted(autoCancel?.status))
      throw new ConflictException({
        message: 'The store is already canceling this order.',
        code: 'AUTO_CANCEL_ALREADY_IN_PROGRESS',
      });

    const command = {
      orgId,
      integrationId: order.integrationId,
      externalOrderId: order.externalOrderId,
      correlationId: verificationId,
    };
    const result = await this.commerceOutcomes.dispatch({
      ...command,
      action: 'merchant_no_reply_cancellation',
    });
    if (result.status === 'unsupported')
      throw new BadRequestException({
        message: 'Order cancellation is not supported by this source',
        code: result.reason,
        operation: { status: result.status, reason: result.reason },
      });
    if (result.status === 'permanent_failure')
      throw new BadRequestException({
        message: 'Order cancellation could not be dispatched',
        code: result.errorCode,
        operation: { status: result.status, errorCode: result.errorCode },
      });
    if (result.status === 'retryable_failure')
      throw new BadGatewayException({
        message: 'Order cancellation failed',
        code: result.errorCode,
        operation: { status: result.status, errorCode: result.errorCode },
      });
    const operation: CommerceOutcomeOperationResult =
      result.status === 'pending_provider_operation'
        ? {
            status: result.status,
            providerOperationId: result.providerOperationId,
          }
        : { status: result.status };

    let resolved: Awaited<
      ReturnType<
        ChangeRequestLifecycleService['recordCancellationAfterContact']
      >
    >;
    try {
      resolved = await this.lifecycle.recordCancellationAfterContact(
        user,
        verificationId,
        operation,
        changeRequestId,
      );
    } catch (error) {
      // The store accepted, but the customer (or another tab) settled the
      // request first. Reported, not overwritten; support sees both.
      this.logger.warn(
        buildBackendLog(ChangeRequestMerchantService.name, {
          action: 'change-request-merchant-cancel-record',
          outcome: 'failure',
          orgId,
          verificationId,
          operationStatus: operation.status,
          ...normalizeError(error),
        }),
      );
      throw error;
    }
    try {
      await this.commerceOutcomes.dispatch({
        ...command,
        action: 'merchant_cancellation_tagging',
      });
    } catch (error) {
      this.logger.warn(
        buildBackendLog(ChangeRequestMerchantService.name, {
          action: 'change-request-merchant-cancel-tag',
          outcome: 'retry',
          orgId,
          verificationId,
          ...normalizeError(error),
        }),
      );
    }
    this.log('change-request-merchant-cancel', orgId, verificationId);
    return {
      success: true,
      verificationId,
      status: 'canceled',
      changeRequestId: resolved.request.id,
      operation,
    };
  }

  /** "Send updated confirmation". */
  resend(
    user: AuthenticatedUser,
    verificationId: string,
    input: { changeRequestId: string; expectedCycle: number },
  ): Promise<ReconfirmationView> {
    return this.reconfirmations.request(user, verificationId, input);
  }

  private log(action: string, orgId: string, verificationId: string) {
    this.logger.log(
      buildBackendLog(ChangeRequestMerchantService.name, {
        action,
        outcome: 'success',
        orgId,
        verificationId,
      }),
    );
  }
}
