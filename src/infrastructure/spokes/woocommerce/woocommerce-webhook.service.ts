import { Injectable } from '@nestjs/common';
import { WooCommerceConnectionsRepository } from '../../database/repositories/woocommerce-connections.repository';
import {
  hashInstallToken,
  isWellFormedInstallToken,
} from './woocommerce-install-token';
import { wooCommerceError } from './woocommerce.errors';

/** The topics Akeed's webhooks are created with. */
const ORDER_DELIVERY_TOPICS = new Set(['order.created', 'order.updated']);

/**
 * A request is an order delivery when `X-WC-Webhook-Topic` names one of the
 * two order topics. Anything else on a known token is treated as the ping
 * WooCommerce sends when a webhook is saved, whose body, content type and
 * headers are not documented (finding 3.10).
 */
export function isOrderDeliveryTopic(topic: unknown): boolean {
  return typeof topic === 'string' && ORDER_DELIVERY_TOPICS.has(topic);
}

/**
 * The delivery URL before ingestion exists (US-07-02). Order deliveries are
 * not accepted yet, so they are answered as not found; US-07-03 adds the
 * three-part check, the routing and the event row.
 */
@Injectable()
export class WooCommerceWebhookService {
  constructor(private readonly connections: WooCommerceConnectionsRepository) {}

  /**
   * The ping rule (contract record section 3): a request that is not an order
   * delivery, on a token Akeed issued, is answered 200 with nothing stored,
   * nothing counted and no check beyond the token. It gives nothing away: the
   * caller already holds the token, and no state changes.
   */
  async handleDelivery(token: string, topic: unknown): Promise<void> {
    if (
      isOrderDeliveryTopic(topic) ||
      !isWellFormedInstallToken(token) ||
      !(await this.connections.isKnownWebhookToken(hashInstallToken(token)))
    )
      throw wooCommerceError('WOOCOMMERCE_INGESTION_UNAVAILABLE');
  }
}
