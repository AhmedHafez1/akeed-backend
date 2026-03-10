import { Inject, Injectable, Logger } from '@nestjs/common';
import { NormalizedOrder } from 'src/core/interfaces/order.interface';
import { OrdersRepository } from 'src/infrastructure/database/repositories/orders.repository';
import { VerificationsRepository } from 'src/infrastructure/database/repositories/verifications.repository';
import { MESSAGING_PORT, type MessagingPort } from '../ports/messaging.port';
import {
  ORDER_TAGGING_PORT,
  type OrderTaggingPort,
} from '../ports/order-tagging.port';
import { integrations, orders } from '../../infrastructure/database/schema';
import { BillingEntitlementService } from './billing-entitlement.service';
import { OrderEligibilityService } from './order-eligibility.service';

@Injectable()
export class VerificationHubService {
  private readonly logger = new Logger(VerificationHubService.name);

  constructor(
    private ordersRepo: OrdersRepository,
    private verificationsRepo: VerificationsRepository,
    @Inject(MESSAGING_PORT) private messagingPort: MessagingPort,
    @Inject(ORDER_TAGGING_PORT) private orderTaggingPort: OrderTaggingPort,
    private billingEntitlementService: BillingEntitlementService,
    private orderEligibilityService: OrderEligibilityService,
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

    const reservation =
      await this.billingEntitlementService.reserveVerificationSlot(integration);
    if (!reservation.allowed) {
      this.logger.warn(
        `Plan limit reached for integration ${integration.id} (${reservation.consumedCount}/${reservation.includedLimit}) in period ${reservation.periodStart}; skipping WhatsApp send for order ${order.id}`,
      );

      verification = await this.verificationsRepo.create({
        orgId: order.orgId,
        orderId: order.id,
        status: 'failed',
        metadata: {
          reason: 'plan_limit_reached',
          planId: reservation.planId,
          periodStart: reservation.periodStart,
          consumedCount: reservation.consumedCount,
          includedLimit: reservation.includedLimit,
        },
      });

      return { orderId: order.id, verificationId: verification.id };
    }

    // 3. Create Verification Record
    try {
      verification = await this.verificationsRepo.create({
        orgId: order.orgId,
        orderId: order.id,
        status: 'pending',
      });
    } catch (error) {
      await this.safeReleaseUsageReservation({
        integrationId: integration.id,
        periodStart: reservation.periodStart,
      });
      throw error;
    }

    // 4. Trigger WhatsApp Message
    this.logger.log(`Triggering WhatsApp for Order ${order.id}...`);
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
      await this.safeReleaseUsageReservation({
        integrationId: integration.id,
        periodStart: reservation.periodStart,
      });
      await this.safeMarkVerificationFailed(verification.id);
      throw error;
    }

    // 5. Update Verification Record with WhatsApp Message ID
    const waMessageId = response?.messages?.[0]?.id;
    if (!waMessageId) {
      this.logger.error(
        `WhatsApp API response did not include a message id for verification ${verification.id}; releasing reserved usage slot`,
      );
      await this.safeReleaseUsageReservation({
        integrationId: integration.id,
        periodStart: reservation.periodStart,
      });
      await this.safeMarkVerificationFailed(verification.id);
      return { orderId: order.id, verificationId: verification.id };
    }

    this.logger.log(`WhatsApp Message Sent with ID: ${waMessageId}`);
    await this.verificationsRepo.updateStatus(
      verification.id,
      'sent',
      waMessageId,
    );

    return { orderId: order.id, verificationId: verification.id };
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

  private async safeReleaseUsageReservation(params: {
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

  private async safeMarkVerificationFailed(
    verificationId: string,
  ): Promise<void> {
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
