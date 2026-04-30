import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { NormalizedOrder } from '../../shared/interfaces/order.interface';
import { OrdersRepository } from '../../infrastructure/database/repositories/orders.repository';
import { VerificationsRepository } from '../../infrastructure/database/repositories/verifications.repository';
import {
  ORDER_TAGGING_PORT,
  type OrderTaggingPort,
} from '../../shared/ports/order-tagging.port';
import { integrations, orders } from '../../infrastructure/database/schema';
import { OrderEligibilityService } from './order-eligibility.service';
import { VerificationSendService } from './verification-send.service';
import { VerificationAutomationProducer } from '../verification-automation/verification-automation.producer';
import { adjustForQuietHours } from '../../shared/utils/quiet-hours.util';

@Injectable()
export class VerificationHubService {
  private readonly logger = new Logger(VerificationHubService.name);

  constructor(
    private ordersRepo: OrdersRepository,
    private verificationsRepo: VerificationsRepository,
    @Inject(ORDER_TAGGING_PORT) private orderTaggingPort: OrderTaggingPort,
    private orderEligibilityService: OrderEligibilityService,
    private verificationSendService: VerificationSendService,
    @Optional()
    private readonly automationProducer?: VerificationAutomationProducer,
  ) {}

  async handleNewOrder(
    orderData: NormalizedOrder,
    integration: typeof integrations.$inferSelect,
  ) {
    const eligibility =
      this.orderEligibilityService.evaluateOrderForVerification({
        order: orderData,
        integration,
      });
    if (!eligibility.eligible) {
      this.logger.log(
        `Skipping order ${orderData.externalOrderId} for integration ${integration.id}: verification is only sent for COD orders (reason=${eligibility.reason}${
          eligibility.matchedSignal
            ? `, signal=${eligibility.matchedSignal}`
            : ''
        })`,
      );
      return { skipped: true, reason: eligibility.reason };
    }

    if (!integration.isAutoVerifyEnabled) {
      this.logger.log(
        `Skipping order ${orderData.externalOrderId} for integration ${integration.id}: auto verification is disabled`,
      );
      return { skipped: true, reason: 'auto_verify_disabled' };
    }

    this.logger.log(`Processing Hub Order: ${orderData.externalOrderId}`);

    // 1. Check if order exists (Idempotency)
    let order = await this.ordersRepo.findByExternalId(
      orderData.externalOrderId,
      orderData.orgId,
    );

    if (!order) {
      order = await this.ordersRepo.create(
        this.toOrderInsertPayload(orderData),
      );
    }

    // 2. Check if we already have a verification for this order
    let verification = await this.verificationsRepo.findByOrderId(order.id);
    if (verification) {
      this.logger.log(`Verification already exists for Order ${order.id}`);
      return { orderId: order.id, verificationId: verification.id };
    }

    // 3. Create the verification record in `pending` state. Billing is only
    //    consumed when the WhatsApp template is actually attempted, so a
    //    delayed initial send (sendDelayMinutes > 0) does not reserve a slot
    //    until the worker fires.
    verification = await this.verificationsRepo.create({
      orgId: order.orgId,
      orderId: order.id,
      status: 'pending',
    });

    const sendDelayMinutes = Math.max(0, integration.sendDelayMinutes ?? 0);

    if (sendDelayMinutes > 0) {
      const desiredDueAt = new Date(Date.now() + sendDelayMinutes * 60_000);
      const adjustedDueAt = adjustForQuietHours(desiredDueAt, {
        enabled: integration.quietHoursEnabled,
        start: integration.quietHoursStart,
        end: integration.quietHoursEnd,
        timezone: integration.timezone,
      });

      await this.scheduleInitialSend({
        verificationId: verification.id,
        orgId: order.orgId,
        dueAt: adjustedDueAt,
      });

      this.logger.log(
        `Scheduled delayed initial send for verification ${verification.id} at ${adjustedDueAt.toISOString()}`,
      );
      return { orderId: order.id, verificationId: verification.id };
    }

    // Immediate send path
    const sendOutcome = await this.verificationSendService.sendInitial(
      verification.id,
    );

    if (sendOutcome.status === 'sent') {
      await this.scheduleFollowUpAndEscalation({
        verificationId: verification.id,
        orgId: order.orgId,
        integration,
        baselineSentAt: sendOutcome.sentAt
          ? new Date(sendOutcome.sentAt)
          : new Date(),
      });
    } else if (sendOutcome.status === 'plan_limit_reached') {
      await this.verificationsRepo.updateByIdForOrg(
        verification.id,
        order.orgId,
        {
          status: 'failed',
          metadata: {
            reason: 'plan_limit_reached',
            kind: 'initial',
          },
        },
      );
    }

    return { orderId: order.id, verificationId: verification.id };
  }

  /**
   * Schedules the follow-up send and the no-reply escalation, applying
   * quiet-hours adjustment and ensuring no-reply runs strictly after a
   * follow-up attempt when follow-ups are enabled.
   */
  async scheduleFollowUpAndEscalation(params: {
    verificationId: string;
    orgId: string;
    integration: typeof integrations.$inferSelect;
    baselineSentAt: Date;
  }): Promise<void> {
    if (!this.automationProducer) {
      this.logger.warn(
        `Skipping follow-up/no-reply scheduling for verification ${params.verificationId}: automation producer not registered`,
      );
      return;
    }

    const { integration, baselineSentAt } = params;
    const baseMs = baselineSentAt.getTime();

    const quietConfig = {
      enabled: integration.quietHoursEnabled,
      start: integration.quietHoursStart,
      end: integration.quietHoursEnd,
      timezone: integration.timezone,
    };

    let followUpDueAt: Date | null = null;
    if (
      integration.followUpEnabled &&
      (integration.followUpDelayMinutes ?? 0) > 0
    ) {
      followUpDueAt = adjustForQuietHours(
        new Date(baseMs + integration.followUpDelayMinutes * 60_000),
        quietConfig,
      );
      await this.automationProducer.enqueueFollowUp({
        verificationId: params.verificationId,
        orgId: params.orgId,
        dueAt: followUpDueAt,
      });
    }

    const escalationMinutes = Math.max(
      0,
      integration.escalationDelayMinutes ?? 0,
    );
    if (escalationMinutes > 0) {
      let escalationDueAt = adjustForQuietHours(
        new Date(baseMs + escalationMinutes * 60_000),
        quietConfig,
      );

      // Preserve at least one follow-up attempt before no-reply fires.
      if (followUpDueAt && escalationDueAt <= followUpDueAt) {
        escalationDueAt = new Date(followUpDueAt.getTime() + 60_000);
      }

      await this.automationProducer.enqueueNoReplyEscalation({
        verificationId: params.verificationId,
        orgId: params.orgId,
        dueAt: escalationDueAt,
      });
    }
  }

  private async scheduleInitialSend(params: {
    verificationId: string;
    orgId: string;
    dueAt: Date;
  }): Promise<void> {
    if (!this.automationProducer) {
      this.logger.warn(
        `Cannot schedule delayed initial send for verification ${params.verificationId}: automation producer not registered`,
      );
      return;
    }
    await this.automationProducer.enqueueInitialSend(params);
  }

  async finalizeVerification(verificationId: string, status: string) {
    this.logger.log(
      `Finalizing Verification ${verificationId} with status: ${status}`,
    );

    // 1. Fetch the full record to get the externalOrderId and orgId
    const verification = await this.verificationsRepo.findById(verificationId);
    if (!verification) return;

    const order = await this.ordersRepo.findById(verification.orderId);
    if (!order) return;

    // 2. Only take action on terminal states (Confirmed/Canceled)
    if (status === 'confirmed' || status === 'canceled') {
      // Skip Shopify tagging for test verifications (no real Shopify order)
      if (order.externalOrderId.startsWith('akeed-test-')) {
        this.logger.log(
          `Skipping Shopify tag for test order ${order.externalOrderId}`,
        );
        return;
      }

      const tag =
        status === 'confirmed' ? 'Akeed: Verified' : 'Akeed: Canceled';

      // 3. Trigger the Shopify Spoke (Adapter)
      // We'll pass the shop domain (stored in integrations) and the order ID
      const integration = order.integration as typeof integrations.$inferSelect;
      if (integration?.platformStoreUrl) {
        try {
          await this.orderTaggingPort.addOrderTag(
            integration,
            order.externalOrderId,
            tag,
          );

          this.logger.log(
            `Shopify Order ${order.externalOrderId} updated with tag: ${tag}`,
          );
        } catch (error) {
          this.logger.error(
            `Failed to update Shopify tag for Order ${order.externalOrderId}: ${error as Error}`,
          );
        }
      } else {
        this.logger.warn(
          `Skipping Shopify tag update for Order ${order.externalOrderId}: No linked integration found (Organization: ${order.orgId})`,
        );
      }
    }
  }

  private toOrderInsertPayload(
    orderData: NormalizedOrder,
  ): typeof orders.$inferInsert {
    return {
      orgId: orderData.orgId,
      integrationId: orderData.integrationId,
      externalOrderId: orderData.externalOrderId,
      orderNumber: orderData.orderNumber,
      customerPhone: orderData.customerPhone,
      customerName: orderData.customerName,
      totalPrice: orderData.totalPrice,
      currency: orderData.currency,
      paymentMethod: orderData.paymentMethod,
      rawPayload: orderData.rawPayload,
    };
  }
}
