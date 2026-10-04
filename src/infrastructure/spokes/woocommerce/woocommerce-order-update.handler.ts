import { Injectable } from '@nestjs/common';
import { CommerceOutcomeSyncsRepository } from '../../database/repositories/commerce-outcome-syncs.repository';
import { OrdersRepository } from '../../database/repositories/orders.repository';
import type {
  WebhookOrderUpdateHandler,
  WebhookOrderUpdateResult,
} from '../../../modules/webhook-queue/interfaces/webhook-order-update-handler.interface';
import type { PlatformType } from '../../../shared/interfaces/commerce-source.interface';
import { readStoredWooCommerceOrder } from './woocommerce-delivery';
import { readWooCommerceOrderId } from './woocommerce-ingestion.policy';
import {
  buildWooCommerceOutcomeMarker,
  isStatusLeftByWooCommerceOutcome,
  readWooCommerceOutcomeMarkers,
  readWooCommerceStatus,
} from './woocommerce-outcome.mapping';

/** Why an update event changed nothing. Recorded on the event. */
export type WooCommerceUpdateEventReason =
  | 'malformed_update_event'
  | 'order_not_owned'
  | 'reflected_outcome'
  | 'remote_status_observed';

/**
 * WooCommerce `order.updated` deliveries for an order Akeed already has
 * (US-07-04, contract record sections 5 and 6).
 *
 * An update never causes an action: nothing is written to the store and no
 * verification changes or starts, so it cannot loop. The handler only says
 * what the event was. Akeed's own write coming back carries the marker of an
 * outcome recorded for that order, in a status that write could have left
 * (`reflected_outcome`). Anything else is the merchant's change and is only
 * recorded: the marker stays on the order, so the marker alone would call
 * every later change of the merchant's a reflection.
 *
 * The order is looked up under the integration the URL token resolved to, so
 * an id that belongs to another tenant resolves to nothing.
 */
@Injectable()
export class WooCommerceOrderUpdateHandler implements WebhookOrderUpdateHandler {
  readonly platform: PlatformType = 'woocommerce';

  constructor(
    private readonly orders: OrdersRepository,
    private readonly syncs: CommerceOutcomeSyncsRepository,
  ) {}

  async handleOrderUpdate(
    rawPayload: Record<string, unknown>,
    integrationId: string,
    orgId: string,
  ): Promise<WebhookOrderUpdateResult> {
    const delivered = readStoredWooCommerceOrder(rawPayload);
    const externalOrderId = delivered
      ? readWooCommerceOrderId(delivered.id)
      : null;
    if (!delivered || !externalOrderId)
      return this.skip('malformed_update_event');

    const order = await this.orders.findBySourceExternalId({
      orgId,
      integrationId,
      externalOrderId,
    });
    if (!order) return this.skip('order_not_owned');

    const status = readWooCommerceStatus(delivered.status);
    const markers = readWooCommerceOutcomeMarkers(delivered.meta_data);
    if (!status || markers.length === 0)
      return this.skip('remote_status_observed');

    // A waiting or failed row counts too: the write may have been taken even
    // though its answer never arrived.
    const outcomes = await this.syncs.findForOrder(
      orgId,
      integrationId,
      order.id,
    );
    const reflected = outcomes.some(
      (outcome) =>
        outcome.state !== 'unsupported' &&
        markers.includes(
          buildWooCommerceOutcomeMarker(outcome.action, outcome.correlationId),
        ) &&
        isStatusLeftByWooCommerceOutcome(outcome.action, status),
    );
    return this.skip(
      reflected ? 'reflected_outcome' : 'remote_status_observed',
    );
  }

  private skip(reason: WooCommerceUpdateEventReason): WebhookOrderUpdateResult {
    return { skipped: true, reason };
  }
}
