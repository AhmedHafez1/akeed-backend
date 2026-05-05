import { Inject, Injectable, Logger } from '@nestjs/common';
import { OrdersRepository } from '../../infrastructure/database/repositories/orders.repository';
import { VerificationsRepository } from '../../infrastructure/database/repositories/verifications.repository';
import { IntegrationsRepository } from '../../infrastructure/database/repositories/integrations.repository';
import {
  MESSAGING_PORT,
  type MessagingPort,
} from '../../shared/ports/messaging.port';
import { integrations } from '../../infrastructure/database/schema';
import { BillingEntitlementService } from './billing-entitlement.service';

export type SendKind = 'initial' | 'follow_up';

export interface SendOutcome {
  status: 'sent' | 'failed' | 'plan_limit_reached' | 'skipped';
  reason?: string;
  waMessageId?: string;
  sentAt?: string;
}

interface ResolvedContext {
  verification: NonNullable<
    Awaited<ReturnType<VerificationsRepository['findById']>>
  >;
  order: NonNullable<Awaited<ReturnType<OrdersRepository['findById']>>>;
  integration: typeof integrations.$inferSelect;
}

/**
 * Shared service that performs the actual WhatsApp template send
 * (initial or follow-up) for an existing verification record.
 *
 * Responsibilities:
 *  - Reload the verification, order and integration with current state.
 *  - Reserve a billing slot at the moment of sending.
 *  - Call MessagingPort.sendVerificationTemplate.
 *  - Translate the response into a verification status update
 *    (`sent` on success, `failed` on send error / missing wamid).
 *  - Release the billing reservation when sending fails.
 *
 * Higher-level scheduling, quiet-hours adjustment, and follow-up/no-reply
 * sequencing live in `VerificationHubService` and the automation processor.
 */
@Injectable()
export class VerificationSendService {
  private readonly logger = new Logger(VerificationSendService.name);

  constructor(
    private readonly verificationsRepo: VerificationsRepository,
    private readonly ordersRepo: OrdersRepository,
    private readonly integrationsRepo: IntegrationsRepository,
    private readonly billingEntitlementService: BillingEntitlementService,
    @Inject(MESSAGING_PORT) private readonly messagingPort: MessagingPort,
  ) {}

  async sendInitial(verificationId: string): Promise<SendOutcome> {
    const ctx = await this.loadContext(verificationId);
    if (!ctx) return { status: 'skipped', reason: 'verification_not_found' };
    return this.sendOnce(ctx, 'initial');
  }

  async sendFollowUp(verificationId: string): Promise<SendOutcome> {
    const ctx = await this.loadContext(verificationId);
    if (!ctx) return { status: 'skipped', reason: 'verification_not_found' };
    return this.sendOnce(ctx, 'follow_up');
  }

  private async loadContext(
    verificationId: string,
  ): Promise<ResolvedContext | null> {
    const verification = await this.verificationsRepo.findById(verificationId);
    if (!verification) return null;

    const order = await this.ordersRepo.findById(verification.orderId);
    if (!order) return null;

    const integration =
      (order.integration as typeof integrations.$inferSelect | null) ??
      (await this.integrationsRepo
        .findActiveByOrgAndPlatform(order.orgId, 'shopify')
        .catch(() => null)) ??
      null;

    if (!integration) return null;

    return { verification, order, integration };
  }

  private async sendOnce(
    ctx: ResolvedContext,
    kind: SendKind,
  ): Promise<SendOutcome> {
    const { verification, order, integration } = ctx;

    const reservation =
      await this.billingEntitlementService.reserveVerificationSlot(integration);
    if (!reservation.allowed) {
      this.logger.warn(
        `Plan limit reached for integration ${integration.id} (${reservation.consumedCount}/${reservation.includedLimit}); skipping ${kind} send for verification ${verification.id}`,
      );
      return {
        status: 'plan_limit_reached',
        reason: `plan_limit:${reservation.consumedCount}/${reservation.includedLimit}`,
      };
    }

    let response: Awaited<
      ReturnType<MessagingPort['sendVerificationTemplate']>
    > | null = null;

    try {
      response = await this.messagingPort.sendVerificationTemplate(
        order.customerPhone,
        order.externalOrderId,
        order.totalPrice!,
        verification.id,
        integration.defaultLanguage,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `WhatsApp send failed for verification ${verification.id} (${kind}): ${message}`,
      );
      await this.safeReleaseUsage({
        integrationId: integration.id,
        periodStart: reservation.periodStart,
      });
      // Follow-up delivery failures should not invalidate the initial
      // verification request; the automation worker records metadata and leaves
      // the verification awaiting the customer's original response.
      if (kind === 'initial') {
        await this.safeMarkFailed(verification.id);
      }
      return { status: 'failed', reason: 'send_error' };
    }

    const waMessageId = response?.messages?.[0]?.id;
    if (!waMessageId) {
      this.logger.error(
        `WhatsApp API response missing message id for verification ${verification.id} (${kind}); releasing reservation`,
      );
      await this.safeReleaseUsage({
        integrationId: integration.id,
        periodStart: reservation.periodStart,
      });
      // Same rationale as send exceptions: a follow-up failure should not mark
      // the whole verification failed after the initial message was sent.
      if (kind === 'initial') {
        await this.safeMarkFailed(verification.id);
      }
      return { status: 'failed', reason: 'missing_wamid' };
    }

    const sentAt = new Date().toISOString();

    if (kind === 'initial') {
      await this.verificationsRepo.updateStatus(
        verification.id,
        'sent',
        waMessageId,
      );
    }

    return { status: 'sent', waMessageId, sentAt };
  }

  private async safeReleaseUsage(params: {
    integrationId: string;
    periodStart: string;
  }): Promise<void> {
    try {
      await this.billingEntitlementService.releaseVerificationSlot(params);
    } catch (error) {
      this.logger.error(
        `Failed to release usage reservation for integration ${params.integrationId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async safeMarkFailed(verificationId: string): Promise<void> {
    try {
      await this.verificationsRepo.updateStatus(verificationId, 'failed');
    } catch (error) {
      this.logger.error(
        `Failed to mark verification ${verificationId} as failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
