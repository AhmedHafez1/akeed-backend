import type { INestApplication } from '@nestjs/common';
import { raw } from 'express';
import { WOOCOMMERCE_WEBHOOK_PATH } from '../../../shared/config/woocommerce.config';

/** Largest delivery body read. An order is far smaller. */
export const WOOCOMMERCE_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

/**
 * Reads every body under the delivery path as raw bytes, whatever its content
 * type. Two findings need it. The content type of a delivery is not
 * documented (3.4), and its signature is over the exact bytes. And the ping
 * must be answered 200 whatever its body is (3.10): left to the app-wide JSON
 * parser, a body it cannot parse would be answered 400 before the route ran.
 */
export const wooCommerceWebhookBodyParser = raw({
  type: () => true,
  limit: WOOCOMMERCE_WEBHOOK_MAX_BODY_BYTES,
});

/**
 * Mounts the parser ahead of Nest's own. Call it before the app is
 * initialised: a parser that runs later finds the body already read and
 * leaves it alone.
 */
export function applyWooCommerceWebhookEdge(app: INestApplication): void {
  app.use(WOOCOMMERCE_WEBHOOK_PATH, wooCommerceWebhookBodyParser);
}
