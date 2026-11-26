import { Injectable, Logger } from '@nestjs/common';
import { ShippingNotificationsRepository } from '../../infrastructure/database/repositories/shipping-notifications.repository';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import { isTemplateLanguage } from '../../shared/messaging/template-registry.types';
import { resolveShippingTrackingLink } from '../../shared/shipping/shipping-courier.policy';
import { isWellFormedShippingTrackingCode } from '../../shared/shipping/shipping-tracking-code';
import type { ShippingTrackingView } from './shipping-tracking.types';

/** A link older than this opens the neutral "not available" page. */
export const SHIPPING_TRACKING_LINK_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * The public side of the Shipped message's Track order button. The code is
 * the only key, so a malformed one never reaches the database, and every
 * redirect target comes from the stored shipment.
 */
@Injectable()
export class ShippingTrackingService {
  private readonly logger = new Logger(ShippingTrackingService.name);

  constructor(private readonly repository: ShippingNotificationsRepository) {}

  async open(
    code: string,
    now: Date = new Date(),
  ): Promise<ShippingTrackingView> {
    if (!isWellFormedShippingTrackingCode(code)) return { kind: 'unavailable' };
    const shipment = await this.repository.findByTrackingCode(code);
    if (
      !shipment ||
      now.getTime() - Date.parse(shipment.createdAt) >
        SHIPPING_TRACKING_LINK_LIFETIME_MS
    )
      return { kind: 'unavailable' };

    await this.markOpened(shipment.id);

    const link = resolveShippingTrackingLink({
      url: shipment.trackingUrl,
      company: shipment.trackingCompany,
      number: shipment.trackingNumber,
    });
    if (link.kind === 'carrier_link' || link.kind === 'courier_page')
      return { kind: 'redirect', url: link.url };
    return {
      kind: 'page',
      language: isTemplateLanguage(shipment.messageLanguage)
        ? shipment.messageLanguage
        : isTemplateLanguage(shipment.storeLanguage)
          ? shipment.storeLanguage
          : 'ar',
      storeName: shipment.storeName?.trim() || null,
      orderNumber: shipment.orderNumber?.trim() || null,
      courier: link.courier,
      trackingNumber:
        link.kind === 'number_only' ? shipment.trackingNumber : null,
    };
  }

  /** Opening the page must not fail because the first-open time could not be saved. */
  private async markOpened(shippingNotificationId: string): Promise<void> {
    try {
      await this.repository.markTrackingOpened(shippingNotificationId);
    } catch (error) {
      this.logger.warn(
        buildBackendLog(ShippingTrackingService.name, {
          action: 'shipping-tracking.mark-opened',
          outcome: 'failure',
          shippingNotificationId,
          error: normalizeError(error),
        }),
      );
    }
  }
}
