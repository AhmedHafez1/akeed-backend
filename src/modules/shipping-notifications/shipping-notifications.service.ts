import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  assertOrganizationWriteAllowed,
  type OrganizationRole,
} from '../auth/organization-role';
import {
  DELIVERY_REQUEST_REPLIES,
  type ShippingCustomerReply,
} from '../../shared/shipping/shipping-notification.types';
import { ConfigService } from '@nestjs/config';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import { readShippingNotificationsConfig } from '../../shared/config/shipping-notifications.config';
import type { PlatformType } from '../../shared/interfaces/commerce-source.interface';
import {
  ShippingNotificationsRepository,
  type ShippingNotificationRow,
} from '../../infrastructure/database/repositories/shipping-notifications.repository';
import { VerificationAutomationProducer } from '../verification-automation/verification-automation.producer';
import type {
  WebhookOrderUpdateHandler,
  WebhookOrderUpdateResult,
} from '../webhook-queue/interfaces/webhook-order-update-handler.interface';
import {
  SHIPPING_EVENT_SOURCES,
  type ShippingEventSource,
} from './shipping-event-source';
import { evaluateShippingEligibility } from './shipping-eligibility.policy';
import { generateShippingTrackingCode } from '../../shared/shipping/shipping-tracking-code';

export interface StoreOrderUpdate {
  platform: PlatformType;
  rawPayload: Record<string, unknown>;
  orgId: string;
  integrationId: string;
}

/**
 * Turns store order-update events into shipping notifications. It knows no
 * platform: each platform's event source reads its own payload, and this
 * service resolves the order, applies eligibility and records the result once
 * per verification and stage.
 */
@Injectable()
export class ShippingNotificationsService {
  private readonly logger = new Logger(ShippingNotificationsService.name);
  private readonly sources: Map<PlatformType, ShippingEventSource>;

  constructor(
    @Inject(SHIPPING_EVENT_SOURCES) sources: ShippingEventSource[],
    private readonly repository: ShippingNotificationsRepository,
    private readonly automation: VerificationAutomationProducer,
    @Optional() private readonly config?: ConfigService,
  ) {
    this.sources = new Map(sources.map((source) => [source.platform, source]));
  }

  /** The env switch. Off: nothing here runs and the settings are hidden. */
  isEnabled(): boolean {
    return this.config
      ? readShippingNotificationsConfig(this.config).enabled
      : false;
  }

  /** Whether a store on this platform can use shipping notifications. */
  isAvailableFor(platform: string): boolean {
    return this.isEnabled() && this.sources.has(platform as PlatformType);
  }

  /** One order-update handler per platform with a shipping event source. */
  orderUpdateHandlers(): WebhookOrderUpdateHandler[] {
    return [...this.sources.keys()].map((platform) => ({
      platform,
      handleOrderUpdate: (rawPayload, integrationId, orgId) =>
        this.handleStoreOrderUpdate({
          platform,
          rawPayload,
          integrationId,
          orgId,
        }),
    }));
  }

  /**
   * Safe to run again on the same event: the record is inserted once, and a
   * pending record's send job has a fixed id.
   */
  async handleStoreOrderUpdate(
    event: StoreOrderUpdate,
  ): Promise<WebhookOrderUpdateResult> {
    if (!this.isEnabled()) return this.skip(event, 'shipping_disabled');
    const source = this.sources.get(event.platform);
    if (!source) return this.skip(event, 'shipping_source_unsupported');

    const ref = source.readOrderRef(event.rawPayload);
    if (!ref) return this.skip(event, 'malformed_order_event');

    const context = await this.repository.findShippingContext({
      orgId: event.orgId,
      integrationId: event.integrationId,
      externalOrderId: ref.externalOrderId,
    });
    if (!context) return this.skip(event, 'order_not_owned');
    if (!context.shippingNotificationsEnabled) {
      return this.skip(event, 'shipping_feature_off');
    }
    if (ref.isTest || context.orderIsTest) {
      return this.skip(event, 'test_order');
    }

    const detection = source.detect(event.rawPayload, {
      fulfillmentTriggerEnabled: context.shippingFulfillmentTriggerEnabled,
      tags: context.shippingTags,
    });
    if (!detection) return this.skip(event, 'no_shipping_signal');

    const eligibility = evaluateShippingEligibility({
      isTest: false,
      verificationStatus: context.verificationStatus,
      verificationCanceledAt: context.verificationCanceledAt,
      merchantCanceledAt: context.merchantCanceledAt,
      sourceCancelledAt: ref.sourceCancelledAt,
      sourceCreatedAt: ref.sourceCreatedAt,
      orderCreatedAt: context.orderCreatedAt,
      now: new Date(),
    });
    if (!eligibility.write) return this.skip(event, 'test_order');

    const inserted = await this.repository.insertIfNew({
      orgId: event.orgId,
      verificationId: context.verificationId,
      stage: detection.stage,
      trigger: detection.trigger,
      matchedTag: detection.trigger === 'tag' ? detection.matchedTag : null,
      trackingNumber: detection.tracking?.number ?? null,
      trackingUrl: detection.tracking?.url ?? null,
      trackingCompany: detection.tracking?.company ?? null,
      // Kept only when this insert wins; an earlier record keeps its own code.
      trackingCode: generateShippingTrackingCode(),
      status: eligibility.status,
      reasonCode: eligibility.status === 'failed' ? eligibility.reason : null,
    });

    const record =
      inserted ??
      (await this.repository.findByVerification({
        orgId: event.orgId,
        verificationId: context.verificationId,
        stage: detection.stage,
      }));
    // A pending record whose job was lost between the insert and the queue is
    // queued again; the fixed job id makes this a no-op while the job exists.
    if (record?.status === 'pending' && record.dispatchId === null) {
      await this.enqueueSend(record);
    }

    this.logger.log(
      buildBackendLog(ShippingNotificationsService.name, {
        action: 'shipping-notification-record',
        outcome: inserted ? 'success' : 'skipped',
        orgId: event.orgId,
        platform: event.platform,
        verificationId: context.verificationId,
        shippingNotificationId: record?.id,
        trigger: detection.trigger,
        status: record?.status,
        reason: inserted
          ? (inserted.reasonCode ?? undefined)
          : 'already_recorded',
      }),
    );
    return inserted
      ? { handled: true }
      : { skipped: true, reason: 'already_recorded' };
  }

  /**
   * Keeps the customer's tap on the Shipped message. Only the first tap
   * counts. A reschedule or address request asks the merchant to act.
   */
  async recordCustomerReply(params: {
    orgId: string;
    verificationId: string;
    reply: ShippingCustomerReply;
    at: string;
  }): Promise<{ recorded: boolean; deliveryRequest: boolean }> {
    const row = await this.repository.recordCustomerReply(params);
    const deliveryRequest = row
      ? DELIVERY_REQUEST_REPLIES.includes(params.reply)
      : false;
    this.logger.log(
      buildBackendLog(ShippingNotificationsService.name, {
        action: 'shipping-customer-reply',
        outcome: row ? 'success' : 'skipped',
        orgId: params.orgId,
        verificationId: params.verificationId,
        reply: params.reply,
        ...(row ? {} : { reason: 'already_answered' }),
      }),
    );
    return { recorded: Boolean(row), deliveryRequest };
  }

  /**
   * The merchant has dealt with what the order's shipping record asks of
   * them: a reschedule or address request, or a Shipped message that could
   * not reach the customer. Viewers are read-only.
   */
  async resolveNeedsAction(
    user: { orgId: string; userId: string; role: OrganizationRole },
    verificationId: string,
  ): Promise<{ resolvedAt: string }> {
    assertOrganizationWriteAllowed(user.role, {
      message: 'Owner or admin role is required to update an order.',
      code: 'VERIFICATION_ROLE_REQUIRED',
    });
    const existing = await this.repository.findByVerification({
      orgId: user.orgId,
      verificationId,
      stage: 'shipped',
    });
    if (!existing)
      throw new NotFoundException({
        statusCode: 404,
        error: 'Not Found',
        message: 'This order has no shipping message.',
        code: 'SHIPPING_NOTIFICATION_NOT_FOUND',
      });
    const at = new Date().toISOString();
    const resolved = await this.repository.resolveNeedsAction({
      orgId: user.orgId,
      verificationId,
      userId: user.userId,
      at,
    });
    if (!resolved)
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'Nothing about this shipment needs action.',
        code: 'SHIPPING_NOTHING_TO_RESOLVE',
      });
    return { resolvedAt: resolved.needsActionResolvedAt ?? at };
  }

  private async enqueueSend(record: ShippingNotificationRow): Promise<void> {
    try {
      await this.automation.enqueueShippingSend({
        verificationId: record.verificationId,
        orgId: record.orgId,
        shippingNotificationId: record.id,
      });
    } catch (error) {
      this.logger.error(
        buildBackendLog(ShippingNotificationsService.name, {
          action: 'shipping-send-enqueue',
          outcome: 'failure',
          orgId: record.orgId,
          verificationId: record.verificationId,
          shippingNotificationId: record.id,
          ...normalizeError(error),
        }),
      );
      // The webhook job retries; the insert is a no-op the next time.
      throw error;
    }
  }

  private skip(
    event: StoreOrderUpdate,
    reason: string,
  ): WebhookOrderUpdateResult {
    this.logger.debug(
      buildBackendLog(ShippingNotificationsService.name, {
        action: 'shipping-order-update',
        outcome: 'skipped',
        orgId: event.orgId,
        platform: event.platform,
        reason,
      }),
    );
    return { skipped: true, reason };
  }
}
