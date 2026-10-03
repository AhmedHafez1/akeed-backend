import { Injectable } from '@nestjs/common';
import { CommerceOutcomeSyncsRepository } from '../../database/repositories/commerce-outcome-syncs.repository';
import { OrdersRepository } from '../../database/repositories/orders.repository';
import type {
  WebhookOrderUpdateHandler,
  WebhookOrderUpdateResult,
} from '../../../modules/webhook-queue/interfaces/webhook-order-update-handler.interface';
import type { PlatformType } from '../../../shared/interfaces/commerce-source.interface';
import {
  easyOrdersStatusFor,
  readEasyOrdersStatus,
} from './easyorders-outcome.mapping';

/** Why a status event changed nothing. Recorded on the event. */
export type EasyOrdersStatusEventReason =
  | 'malformed_status_event'
  | 'order_not_owned'
  | 'reflected_outcome'
  | 'remote_status_observed';

/**
 * EasyOrders order-status events (US-06-04, contract record sections 5, 6).
 *
 * A status event never causes an action: nothing is written to EasyOrders and
 * no verification changes, so it cannot loop. The handler only says what the
 * event was. A change to the status Akeed itself asked for on that order is
 * its own write coming back (`reflected_outcome`); any other change is the
 * merchant's and is only recorded.
 *
 * The order is looked up under the integration the URL token resolved to, so
 * an id that belongs to another tenant resolves to nothing.
 */
@Injectable()
export class EasyOrdersStatusUpdateHandler implements WebhookOrderUpdateHandler {
  readonly platform: PlatformType = 'easyorders';

  constructor(
    private readonly orders: OrdersRepository,
    private readonly syncs: CommerceOutcomeSyncsRepository,
  ) {}

  async handleOrderUpdate(
    rawPayload: Record<string, unknown>,
    integrationId: string,
    orgId: string,
  ): Promise<WebhookOrderUpdateResult> {
    const externalOrderId =
      typeof rawPayload.order_id === 'string' ? rawPayload.order_id : '';
    const newStatus = readEasyOrdersStatus(rawPayload.new_status);
    if (!externalOrderId || !newStatus)
      return this.skip('malformed_status_event');

    const order = await this.orders.findBySourceExternalId({
      orgId,
      integrationId,
      externalOrderId,
    });
    if (!order) return this.skip('order_not_owned');

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
        easyOrdersStatusFor(outcome.action) === newStatus,
    );
    return this.skip(
      reflected ? 'reflected_outcome' : 'remote_status_observed',
    );
  }

  private skip(reason: EasyOrdersStatusEventReason): WebhookOrderUpdateResult {
    return { skipped: true, reason };
  }
}
