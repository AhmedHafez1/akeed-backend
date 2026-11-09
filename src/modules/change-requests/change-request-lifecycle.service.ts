import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  VerificationChangeRequestsRepository,
  type ChangeRequestRow,
  type MerchantResolutionResult,
  type OpenChangeRequestInput,
  type OpenChangeRequestResult,
  type ReconfirmationResult,
} from '../../infrastructure/database/repositories/verification-change-requests.repository';
import { CommerceOutcomeRegistryService } from '../commerce-outcomes/commerce-outcome-registry.service';
import { VerificationAutomationProducer } from '../verification-automation/verification-automation.producer';
import { VerificationsRepository } from '../../infrastructure/database/repositories/verifications.repository';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { assertOrganizationWriteAllowed } from '../auth/organization-role';
import type { CommerceOutcomeOperationResult } from '../../shared/commerce/commerce-outcome';
import { isSyntheticOrder } from '../../shared/commerce/synthetic-order';
import {
  CHANGE_REQUEST_OPENABLE_STATUSES,
  shippingStateFromInspection,
  type ShippingState,
} from '../../shared/verification/change-request.policy';
import type { CustomerReplyIntent } from '../../shared/verification/customer-reply-intent';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';

export type OpenFromCustomerInput = Omit<OpenChangeRequestInput, 'shipping'>;

/**
 * The application commands of a customer change request.
 *
 * Opening reads the store for shipping evidence before the transaction (a
 * read that fails or that the source cannot answer leaves it unknown, which
 * does not block), commits the request with its effects, and only then
 * removes the delayed reminder and no-reply jobs. Those removals are a
 * convenience: every reminder, escalation and automatic cancellation checks
 * for an open request again when it runs.
 *
 * Merchant commands are tenant-scoped and need the owner or admin role. They
 * change only Akeed's state; the caller sends the outcome to the store and
 * the customer (later stories), after the commit.
 */
@Injectable()
export class ChangeRequestLifecycleService {
  private readonly logger = new Logger(ChangeRequestLifecycleService.name);

  constructor(
    private readonly repo: VerificationChangeRequestsRepository,
    private readonly verificationsRepo: VerificationsRepository,
    private readonly commerceOutcomes: CommerceOutcomeRegistryService,
    @Optional()
    private readonly automation?: VerificationAutomationProducer,
  ) {}

  /** A customer's current-cycle Request a change tap. Never guesses a tenant. */
  async openFromCustomer(
    input: OpenFromCustomerInput,
  ): Promise<OpenChangeRequestResult> {
    const shipping = await this.readShippingState(input.verificationId);
    const result = await this.repo.open({ ...input, shipping });
    this.logger.log(
      buildBackendLog(ChangeRequestLifecycleService.name, {
        action: 'change-request-open',
        outcome: result.outcome === 'rejected' ? 'skipped' : 'success',
        verificationId: input.verificationId,
        result: result.outcome,
        ...(result.outcome === 'rejected' ? { reason: result.reason } : {}),
        ...(result.outcome === 'opened'
          ? { orgId: result.request.orgId, shipping }
          : {}),
      }),
    );
    if (result.outcome === 'opened') {
      await this.stopPendingAutomation(result.request);
    }
    return result;
  }

  /**
   * The customer's own Confirm or Cancel was written; it closes an open
   * request of the current cycle. Never throws: the answer is already saved,
   * and a webhook retry calls this again.
   */
  async resolveByCustomerAnswer(input: {
    verificationId: string;
    intent: CustomerReplyIntent;
    eventId?: string;
    occurredAt?: string;
  }): Promise<ChangeRequestRow | null> {
    try {
      const result = await this.repo.resolveByCustomerAnswer(input);
      return result?.request ?? null;
    } catch (error) {
      this.logger.error(
        buildBackendLog(ChangeRequestLifecycleService.name, {
          action: 'change-request-customer-resolution',
          outcome: 'failure',
          verificationId: input.verificationId,
          ...normalizeError(error),
        }),
      );
      return null;
    }
  }

  /** "Confirmed after contacting customer". */
  async confirmAfterContact(
    user: AuthenticatedUser,
    verificationId: string,
    changeRequestId?: string,
  ): Promise<Extract<MerchantResolutionResult, { outcome: 'resolved' }>> {
    assertOrganizationWriteAllowed(user.role, {
      message: 'Owner or admin role is required to confirm an order.',
      code: 'VERIFICATION_ROLE_REQUIRED',
    });
    return this.expectResolved(
      await this.repo.resolveByMerchantConfirmation({
        orgId: user.orgId,
        verificationId,
        changeRequestId,
        actorUserId: user.userId,
      }),
    );
  }

  /**
   * Whether a merchant command may still act on this order, read before the
   * store is asked to cancel it: the request is open and the order awaits
   * confirmation. The transition checks it again under the lock.
   */
  async assertMerchantActionable(
    user: AuthenticatedUser,
    verificationId: string,
  ): Promise<ChangeRequestRow> {
    const verification = await this.verificationsRepo.findByIdForOrg(
      verificationId,
      user.orgId,
    );
    if (!verification || verification.orgId !== user.orgId)
      throw new NotFoundException({
        message: 'Verification not found',
        code: 'VERIFICATION_NOT_FOUND',
      });
    const request = await this.repo.findOpenForVerification(
      verificationId,
      user.orgId,
    );
    if (!request)
      throw new ConflictException({
        message: 'This change request is no longer open.',
        code: 'CHANGE_REQUEST_NOT_OPEN',
        verificationStatus: verification.status,
      });
    if (
      !(CHANGE_REQUEST_OPENABLE_STATUSES as readonly string[]).includes(
        verification.status,
      )
    )
      throw new ConflictException({
        message: 'The order is no longer awaiting confirmation.',
        code: 'CHANGE_REQUEST_NOT_ACTIONABLE',
      });
    return request;
  }

  /**
   * "Cancelled after contacting customer", recorded once the store accepted
   * the cancellation.
   */
  async recordCancellationAfterContact(
    user: AuthenticatedUser,
    verificationId: string,
    operation?: CommerceOutcomeOperationResult,
    changeRequestId?: string,
  ): Promise<Extract<MerchantResolutionResult, { outcome: 'resolved' }>> {
    assertOrganizationWriteAllowed(user.role, {
      message: 'Owner or admin role is required to cancel an order.',
      code: 'VERIFICATION_ROLE_REQUIRED',
    });
    return this.expectResolved(
      await this.repo.resolveByMerchantCancellation({
        orgId: user.orgId,
        verificationId,
        changeRequestId,
        actorUserId: user.userId,
        operation,
      }),
    );
  }

  /** An updated confirmation was accepted: start the next cycle. */
  async completeReconfirmation(input: {
    orgId: string;
    verificationId: string;
    changeRequestId: string;
    expectedCycle: number;
    providerMessageId: string;
    sentAt: string;
    actorUserId?: string | null;
  }): Promise<ReconfirmationResult> {
    const result = await this.repo.completeReconfirmation(input);
    this.logger.log(
      buildBackendLog(ChangeRequestLifecycleService.name, {
        action: 'change-request-reconfirmation',
        outcome: result.outcome === 'completed' ? 'success' : 'skipped',
        orgId: input.orgId,
        verificationId: input.verificationId,
        result: result.outcome,
        ...(result.outcome === 'rejected' ? { reason: result.reason } : {}),
      }),
    );
    return result;
  }

  /** An updated confirmation was not sent; the request stays open. */
  async recordReconfirmationFailure(input: {
    orgId: string;
    verificationId: string;
    changeRequestId: string;
    reason: string;
    actorUserId?: string | null;
  }): Promise<'recorded' | 'not_open'> {
    return this.repo.recordReconfirmationFailure(input);
  }

  private expectResolved(
    result: MerchantResolutionResult,
  ): Extract<MerchantResolutionResult, { outcome: 'resolved' }> {
    if (result.outcome === 'resolved') return result;
    return throwMerchantRejection(result);
  }

  /**
   * Shipping evidence for a new request. Skipped for a repeat tap (nothing
   * would open) and for test orders; never throws.
   */
  private async readShippingState(
    verificationId: string,
  ): Promise<ShippingState> {
    try {
      const target = await this.repo.findOrderForVerification(verificationId);
      if (
        !target ||
        isSyntheticOrder(target) ||
        !(CHANGE_REQUEST_OPENABLE_STATUSES as readonly string[]).includes(
          target.verificationStatus,
        ) ||
        (await this.repo.findOpenForVerification(verificationId, target.orgId))
      )
        return 'unknown';
      return shippingStateFromInspection(
        await this.commerceOutcomes.inspectForCancellation({
          orgId: target.orgId,
          integrationId: target.integrationId,
          externalOrderId: target.externalOrderId,
          action: 'automatic_no_reply_cancellation',
          correlationId: verificationId,
        }),
      );
    } catch (error) {
      this.logger.warn(
        buildBackendLog(ChangeRequestLifecycleService.name, {
          action: 'change-request-shipping-read',
          outcome: 'failure',
          verificationId,
          ...normalizeError(error),
        }),
      );
      return 'unknown';
    }
  }

  private async stopPendingAutomation(request: ChangeRequestRow) {
    try {
      await this.automation?.cancelPendingReminders({
        verificationId: request.verificationId,
        orgId: request.orgId,
      });
      await this.verificationsRepo.removeMetadataKeys(request.verificationId, [
        'follow_up_due_at',
      ]);
    } catch (error) {
      this.logger.warn(
        buildBackendLog(ChangeRequestLifecycleService.name, {
          action: 'change-request-stop-automation',
          outcome: 'failure',
          orgId: request.orgId,
          verificationId: request.verificationId,
          ...normalizeError(error),
        }),
      );
    }
  }
}

/**
 * The coded HTTP error for a merchant command that could not act. The
 * dashboard translates by code, so never rename one: a request settled first
 * (by the customer, another tab or a resend) reads as already resolved, with
 * the outcome that won, so the page can refresh instead of overwriting it.
 */
export function throwMerchantRejection(
  result: Exclude<MerchantResolutionResult, { outcome: 'resolved' }>,
): never {
  if (result.outcome === 'already_resolved')
    throw new ConflictException({
      message: 'This change request was already resolved.',
      code: 'CHANGE_REQUEST_ALREADY_RESOLVED',
      resolution: result.request?.resolution ?? null,
      verificationStatus: result.verificationStatus,
    });
  switch (result.reason) {
    case 'verification_not_found':
      throw new NotFoundException({
        message: 'Verification not found',
        code: 'VERIFICATION_NOT_FOUND',
      });
    case 'auto_cancel_committed':
      throw new ConflictException({
        message: 'The store is already canceling this order.',
        code: 'AUTO_CANCEL_ALREADY_IN_PROGRESS',
      });
    case 'no_open_request':
      throw new ConflictException({
        message: 'This order has no open change request.',
        code: 'CHANGE_REQUEST_NOT_OPEN',
      });
    case 'request_mismatch':
    case 'stale_cycle':
      throw new ConflictException({
        message: 'This change request was replaced by a newer one.',
        code: 'CHANGE_REQUEST_STALE',
      });
    case 'not_awaiting_confirmation':
      throw new ConflictException({
        message: 'The order is no longer awaiting confirmation.',
        code: 'CHANGE_REQUEST_NOT_ACTIONABLE',
      });
  }
}
