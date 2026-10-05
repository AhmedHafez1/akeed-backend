import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import {
  buildWooCommerceSourceIdentity,
  WooCommerceConnectionsRepository,
  type WooCommerceConnection,
} from '../../database/repositories/woocommerce-connections.repository';
import { WebhookEventsRepository } from '../../database/repositories/webhook-events.repository';
import { WebhookQueueProducer } from '../../../modules/webhook-queue/webhook-queue.producer';
import { readWooCommerceConfig } from '../../../shared/config/woocommerce.config';
import {
  buildBackendLog,
  normalizeError,
} from '../../../shared/logging/backend-log.util';
import { decryptToken } from '../../../shared/utils/token-encryption.util';
import { isRecord, toStoredWooCommerceDelivery } from './woocommerce-delivery';
import {
  buildWooCommerceOrderCreateKey,
  readWooCommerceOrderId,
  routeWooCommerceDelivery,
} from './woocommerce-ingestion.policy';
import {
  hashInstallToken,
  isWellFormedInstallToken,
} from './woocommerce-install-token';
import { canonicalizeWooCommerceStoreUrl } from './woocommerce-store-url';
import { wooCommerceError } from './woocommerce.errors';

/** The `X-WC-Webhook-*` headers of a delivery (finding 3.2). All untrusted. */
export interface WooCommerceDeliveryHeaders {
  topic?: unknown;
  signature?: unknown;
  source?: unknown;
  webhookId?: unknown;
  deliveryId?: unknown;
}

/** Why a delivery was refused. Logged, never answered. */
type RefusalReason =
  | 'unknown_token'
  | 'secret_unreadable'
  | 'signature_mismatch'
  | 'source_mismatch';

const PLATFORM = 'woocommerce';

/** The topics Akeed's webhooks are created with. */
const ORDER_DELIVERY_TOPICS = new Set(['order.created', 'order.updated']);

/** A base64 SHA-256 digest: 32 bytes, 44 characters. */
const SIGNATURE_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

/**
 * A request is an order delivery when `X-WC-Webhook-Topic` names one of the
 * two order topics. Anything else on a known token is treated as the ping
 * WooCommerce sends when a webhook is saved, whose body, content type and
 * headers are not documented (finding 3.10).
 */
export function isOrderDeliveryTopic(topic: unknown): topic is string {
  return typeof topic === 'string' && ORDER_DELIVERY_TOPICS.has(topic);
}

/**
 * `X-WC-Webhook-Signature` is the base64 HMAC-SHA256 of the request body
 * (finding 2.12). It is computed over the bytes as they arrived, never over a
 * re-serialized body, and compared in constant time after a length check.
 */
export function isValidWooCommerceSignature(
  rawBody: Buffer,
  signature: unknown,
  secret: string,
): boolean {
  if (typeof signature !== 'string' || !SIGNATURE_PATTERN.test(signature))
    return false;
  const given = Buffer.from(signature, 'base64');
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function parseJson(rawBody: Buffer): unknown {
  try {
    return JSON.parse(rawBody.toString('utf8'));
  } catch {
    return undefined;
  }
}

/**
 * WooCommerce delivery ingress (US-07-03, contract record sections 2, 3, 4
 * and 6).
 *
 * An order delivery is accepted only after three checks, in this order and
 * before any business work: the per-install URL token, which alone decides
 * the tenant; the raw-body HMAC against that install's secret; and
 * `X-WC-Webhook-Source` against the bound store. Nothing is stored before all
 * three hold, and the answer is 2xx only after the event row is written:
 * WooCommerce is assumed not to send a failed delivery again, and five
 * non-2xx answers in a row disable the webhook (finding 3.11).
 */
@Injectable()
export class WooCommerceWebhookService {
  private readonly logger = new Logger(WooCommerceWebhookService.name);

  constructor(
    private readonly connections: WooCommerceConnectionsRepository,
    private readonly events: WebhookEventsRepository,
    private readonly producer: WebhookQueueProducer,
    private readonly config: ConfigService,
  ) {}

  async handleDelivery(
    token: string,
    headers: WooCommerceDeliveryHeaders,
    body: unknown,
  ): Promise<void> {
    const { ingestionEnabled } = readWooCommerceConfig(this.config);
    const tokenHash = isWellFormedInstallToken(token)
      ? hashInstallToken(token)
      : undefined;
    const { topic } = headers;

    // The ping rule: a request that is not an order delivery, on a token
    // Akeed issued, is answered 200 with nothing stored, nothing counted and
    // no check beyond the token. It gives nothing away: the caller already
    // holds the token, and no state changes.
    if (!isOrderDeliveryTopic(topic)) {
      if (tokenHash && (await this.connections.isKnownWebhookToken(tokenHash)))
        return;
      throw ingestionEnabled
        ? this.refuse(undefined, 'unknown_token')
        : wooCommerceError('WOOCOMMERCE_INGESTION_UNAVAILABLE');
    }
    if (!ingestionEnabled)
      throw wooCommerceError('WOOCOMMERCE_INGESTION_UNAVAILABLE');

    const connection = tokenHash
      ? await this.connections.findByWebhookTokenHash(tokenHash)
      : undefined;
    if (!connection) {
      // The install this token belongs to is still connecting: there is no
      // stored secret to check against yet, so the order is not taken.
      if (tokenHash && (await this.connections.isKnownWebhookToken(tokenHash)))
        return this.logIgnored(undefined, topic, 'install_in_flight');
      throw this.refuse(undefined, 'unknown_token');
    }

    const rawBody = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
    await this.authenticate(connection, headers, rawBody);

    const order = parseJson(rawBody);
    const orderId = isRecord(order) ? readWooCommerceOrderId(order.id) : null;
    if (!isRecord(order) || !orderId)
      return this.logIgnored(connection, topic, 'no_order_id');

    await this.accept(connection, orderId, {
      topic,
      webhookId: headers.webhookId,
      deliveryId: headers.deliveryId,
      order,
    });
  }

  /** Parts two and three of the check; a failure of either is counted. */
  private async authenticate(
    connection: WooCommerceConnection,
    headers: WooCommerceDeliveryHeaders,
    rawBody: Buffer,
  ): Promise<void> {
    let reason: RefusalReason | undefined;
    let secret: string | undefined;
    // Null only on a disconnected row, whose token resolves to nothing.
    const stored = connection.webhookSecretEncrypted;
    try {
      secret = stored
        ? decryptToken(
            stored,
            this.config.getOrThrow<string>('SHOPIFY_TOKEN_ENCRYPTION_KEY'),
          )
        : undefined;
    } catch {
      secret = undefined;
    }
    // `decryptToken` hands back what is not in its envelope unchanged. A
    // stored value is never used as a key itself.
    if (secret === undefined || secret === stored) reason = 'secret_unreadable';
    else if (!isValidWooCommerceSignature(rawBody, headers.signature, secret))
      reason = 'signature_mismatch';

    // Strict equality after canonicalization (findings 2.9 and 2.16): a
    // different spelling is refused, never accepted.
    if (!reason) {
      const reported = canonicalizeWooCommerceStoreUrl(headers.source);
      if (!reported.ok || reported.url !== connection.storeUrl)
        reason = 'source_mismatch';
    }
    if (!reason) return;

    await this.connections.recordRejectedDelivery(
      connection.integrationId,
      connection.orgId,
    );
    throw this.refuse(connection, reason);
  }

  private async accept(
    connection: WooCommerceConnection,
    orderId: string,
    delivery: {
      topic: string;
      webhookId: unknown;
      deliveryId: unknown;
      order: Record<string, unknown>;
    },
  ): Promise<void> {
    const { integrationId, orgId } = connection;
    // The tenant is the one the URL token resolved to. Nothing in the payload
    // or a header chooses it.
    const storeDomain = buildWooCommerceSourceIdentity(orgId);
    const stored = toStoredWooCommerceDelivery(delivery, delivery.order);

    let route: ReturnType<typeof routeWooCommerceDelivery>;
    let result: { enqueued: boolean; duplicate?: boolean };
    try {
      const createEvent = await this.events.findBySourceAndIdempotency(
        PLATFORM,
        storeDomain,
        buildWooCommerceOrderCreateKey(integrationId, orderId),
      );
      route = routeWooCommerceDelivery({
        integrationId,
        orderId,
        order: stored.order,
        connectedAt: connection.connectedAt,
        hasCreateEvent: Boolean(createEvent),
      });
      result = await this.producer.ingest({
        platform: PLATFORM,
        storeDomain,
        jobType: route.jobType,
        idempotencyKey: route.idempotencyKey,
        rawPayload: { ...stored },
      });
    } catch (error) {
      // The event is lost unless the store sends it again, which is unknown
      // (finding 3.18). Logged apart from a refused delivery.
      this.logger.error(
        buildBackendLog(WooCommerceWebhookService.name, {
          action: 'woocommerce-webhook-not-persisted',
          outcome: 'failure',
          orgId,
          integrationId,
          topic: delivery.topic,
          ...normalizeError(error),
        }),
      );
      throw error;
    }

    this.logger.log(
      buildBackendLog(WooCommerceWebhookService.name, {
        action: 'woocommerce-webhook-accept',
        outcome: result.duplicate ? 'skipped' : 'success',
        orgId,
        integrationId,
        topic: delivery.topic,
        route: route.route,
        queued: result.enqueued,
        ...(result.duplicate
          ? { reason: 'duplicate_webhook' }
          : route.route === 'skipped'
            ? { reason: route.reason }
            : {}),
      }),
    );
  }

  /** Answered 200 with nothing stored (contract record section 3). */
  private logIgnored(
    connection: WooCommerceConnection | undefined,
    topic: string,
    reason: 'install_in_flight' | 'no_order_id',
  ): void {
    this.logger.warn(
      buildBackendLog(WooCommerceWebhookService.name, {
        action: 'woocommerce-webhook-accept',
        outcome: 'skipped',
        orgId: connection?.orgId,
        integrationId: connection?.integrationId,
        topic,
        reason,
      }),
    );
  }

  /** One answer for every refusal; only the log says which part failed. */
  private refuse(
    connection: WooCommerceConnection | undefined,
    reason: RefusalReason,
  ) {
    this.logger.warn(
      buildBackendLog(WooCommerceWebhookService.name, {
        action: 'woocommerce-webhook-refused',
        outcome: 'failure',
        orgId: connection?.orgId,
        integrationId: connection?.integrationId,
        reason,
        errorCode: 'WOOCOMMERCE_WEBHOOK_UNAUTHORIZED',
      }),
    );
    return wooCommerceError('WOOCOMMERCE_WEBHOOK_UNAUTHORIZED');
  }
}
