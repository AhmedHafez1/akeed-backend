import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import {
  buildEasyOrdersSourceIdentity,
  EasyOrdersConnectionsRepository,
  type EasyOrdersConnection,
} from '../../database/repositories/easyorders-connections.repository';
import { WebhookQueueProducer } from '../../../modules/webhook-queue/webhook-queue.producer';
import { WebhookJobType } from '../../../modules/webhook-queue/webhook-queue.constants';
import { readEasyOrdersConfig } from '../../../shared/config/easyorders.config';
import {
  buildBackendLog,
  normalizeError,
} from '../../../shared/logging/backend-log.util';
import {
  decryptToken,
  encryptToken,
} from '../../../shared/utils/token-encryption.util';
import {
  hashInstallToken,
  isWellFormedInstallToken,
} from '../../../shared/commerce/install-token';
import { EASYORDERS_WEBHOOK_SECRET_PATTERN } from './dto/easyorders-connection.dto';
import { EasyOrdersApiClient } from './easyorders-api.client';
import { readEasyOrdersApiKey } from './easyorders-credentials';
import {
  buildOrderCreatedKey,
  buildOrderStatusKey,
  EASYORDERS_STATUS_EVENT_TYPE,
  EASYORDERS_UNVERIFIED_MARKER,
  isEasyOrdersOpaqueId,
  isEasyOrdersOpaqueStatus,
  isRecord,
} from './easyorders-ingestion.policy';
import { EasyOrdersRateLimiter } from './easyorders-rate-limiter';
import { easyOrdersError } from './easyorders.errors';

export type EasyOrdersWebhookKind = 'orders' | 'status';

export interface EasyOrdersWebhookAck {
  received: true;
  duplicate?: true;
}

/**
 * A delivery that passed the door. `candidate` is the secret it carried when
 * Akeed holds none yet for that webhook: it is kept only once the delivery is
 * proven to come from the store.
 */
interface AuthenticatedDelivery {
  connection: EasyOrdersConnection;
  candidate: string | null;
}

/** `unknown`: EasyOrders gave no answer that settles it either way. */
type DeliveryProof = 'verified' | 'unknown';

/**
 * The `secret` header is a static shared secret, not a signature (contract
 * record section 2): it is compared in constant time after a length check and
 * proves nothing about the body.
 */
function secretsMatch(given: unknown, expected: string): boolean {
  if (typeof given !== 'string') return false;
  const left = Buffer.from(given, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * EasyOrders webhook ingress (US-06-03).
 *
 * A delivery is accepted only with both factors: the per-install URL token,
 * which alone decides the tenant, and that webhook's `secret` header. An order
 * must also name the store the integration is bound to. Nothing is persisted
 * before all of that holds, and the answer is 200 only after the event row is
 * written: EasyOrders is assumed not to retry.
 *
 * EasyOrders never hands the secret to Akeed (contract record section 7), so
 * it is learned: while none is held for a webhook, the order a delivery names
 * is read back with the integration's own key, and the secret of the first
 * delivery that names a real order of the bound store is kept. A delivery
 * naming an order the key cannot see, or another store's order, is refused.
 * When EasyOrders gives no answer that settles it, the delivery is still
 * taken, so no order is lost, and an order is marked for the normalizer to
 * read back before it becomes one.
 */
@Injectable()
export class EasyOrdersWebhookService {
  private readonly logger = new Logger(EasyOrdersWebhookService.name);

  constructor(
    private readonly connections: EasyOrdersConnectionsRepository,
    private readonly producer: WebhookQueueProducer,
    private readonly config: ConfigService,
    private readonly api: EasyOrdersApiClient,
    private readonly limiter: EasyOrdersRateLimiter,
  ) {}

  async handleOrderCreated(
    token: string,
    secret: unknown,
    body: unknown,
  ): Promise<EasyOrdersWebhookAck> {
    const { connection, candidate } = await this.authenticate(
      'orders',
      token,
      secret,
    );
    // The marker is Akeed's own: a payload cannot bring it.
    const payload = isRecord(body) ? { ...body } : {};
    delete payload[EASYORDERS_UNVERIFIED_MARKER];

    if (payload.store_id !== connection.storeId)
      throw this.refuse(
        'orders',
        connection,
        'EASYORDERS_WEBHOOK_STORE_MISMATCH',
      );
    // The order payload has no event type. One that has is another event, and
    // only an order may reach the create path.
    if ('event_type' in payload || !isEasyOrdersOpaqueId(payload.id))
      throw this.refuse('orders', connection, 'EASYORDERS_WEBHOOK_MALFORMED');

    const proof =
      candidate === null
        ? 'verified'
        : await this.learnSecret('orders', connection, candidate, payload.id);

    return this.accept('orders', connection, {
      jobType: WebhookJobType.ORDER_CREATE,
      idempotencyKey: buildOrderCreatedKey(
        connection.integrationId,
        payload.id,
      ),
      rawPayload:
        proof === 'verified'
          ? payload
          : { ...payload, [EASYORDERS_UNVERIFIED_MARKER]: true },
    });
  }

  /**
   * Status events are recorded here and classified by the worker's
   * `EasyOrdersStatusUpdateHandler`, which never acts on one: no order is
   * written and no verification changes.
   */
  async handleStatusUpdate(
    token: string,
    secret: unknown,
    body: unknown,
  ): Promise<EasyOrdersWebhookAck> {
    const { connection, candidate } = await this.authenticate(
      'status',
      token,
      secret,
    );
    const payload = isRecord(body) ? body : {};
    const {
      order_id: orderId,
      old_status: oldStatus,
      new_status: newStatus,
    } = payload;

    if (
      payload.event_type !== EASYORDERS_STATUS_EVENT_TYPE ||
      !isEasyOrdersOpaqueId(orderId) ||
      !isEasyOrdersOpaqueStatus(oldStatus) ||
      !isEasyOrdersOpaqueStatus(newStatus)
    )
      throw this.refuse('status', connection, 'EASYORDERS_WEBHOOK_MALFORMED');

    // Unproven status events need no marker: the handler only records them,
    // and only against an order this integration already owns.
    if (candidate !== null)
      await this.learnSecret('status', connection, candidate, orderId);

    return this.accept('status', connection, {
      jobType: WebhookJobType.ORDER_UPDATE,
      idempotencyKey: buildOrderStatusKey(connection.integrationId, {
        orderId,
        oldStatus,
        newStatus,
      }),
      rawPayload: payload,
    });
  }

  private async authenticate(
    kind: EasyOrdersWebhookKind,
    token: string,
    secret: unknown,
  ): Promise<AuthenticatedDelivery> {
    if (!readEasyOrdersConfig(this.config).ingestionEnabled)
      throw easyOrdersError('EASYORDERS_INGESTION_UNAVAILABLE');

    const source = isWellFormedInstallToken(token)
      ? await this.connections.findByWebhookTokenHash(hashInstallToken(token))
      : undefined;
    if (!source || !source.sourceActive)
      throw this.unauthorized(
        kind,
        source?.connection,
        source ? 'source_inactive' : 'unknown_token',
      );

    const { connection } = source;
    const encrypted =
      kind === 'orders'
        ? connection.ordersWebhookSecretEncrypted
        : connection.statusWebhookSecretEncrypted;
    if (!encrypted) {
      // Nothing to compare with yet. Only something shaped like a secret is
      // worth a read-back; anything else is not an EasyOrders delivery.
      if (
        typeof secret !== 'string' ||
        !EASYORDERS_WEBHOOK_SECRET_PATTERN.test(secret)
      )
        throw this.unauthorized(kind, connection, 'secret_malformed');
      return { connection, candidate: secret };
    }

    let expected: string;
    try {
      expected = decryptToken(encrypted, this.encryptionKey());
    } catch {
      throw this.unauthorized(kind, connection, 'secret_unreadable');
    }
    if (!secretsMatch(secret, expected)) {
      await this.connections.recordRejectedDelivery(
        connection.integrationId,
        connection.orgId,
      );
      throw this.unauthorized(kind, connection, 'secret_mismatch');
    }
    return { connection, candidate: null };
  }

  /**
   * Decides whether a delivery that arrived before its secret was known is
   * real, by reading the order it names with the integration's own key, and
   * keeps the secret when it is. One read, inside the rate budget; a missing
   * budget or a missing answer proves nothing and is not held against it.
   */
  private async learnSecret(
    kind: EasyOrdersWebhookKind,
    connection: EasyOrdersConnection,
    candidate: string,
    orderId: string,
  ): Promise<DeliveryProof> {
    const { integrationId, orgId } = connection;
    const apiKey = readEasyOrdersApiKey(connection, this.encryptionKey());
    if (!apiKey || !this.limiter.acquire(integrationId, 'lookup').allowed)
      return 'unknown';

    const result = await this.api.getOrder(apiKey, orderId);
    if (result.kind === 'rate_limited' && result.retryAfterMs !== null)
      this.limiter.pause(integrationId, result.retryAfterMs);
    // An answer without a store id names no store, so it proves nothing
    // either way (the normalizer treats it the same).
    const storeId = result.kind === 'found' ? result.order.store_id : null;
    const forged =
      result.kind === 'not_found' ||
      (typeof storeId === 'string' && storeId !== connection.storeId);
    if (forged) {
      await this.connections.recordRejectedDelivery(integrationId, orgId);
      throw this.unauthorized(kind, connection, 'unverified_delivery');
    }
    if (storeId !== connection.storeId) return 'unknown';

    const learned = await this.connections.learnWebhookSecret(
      integrationId,
      orgId,
      kind,
      encryptToken(candidate, this.encryptionKey()),
    );
    this.logger.log(
      buildBackendLog(EasyOrdersWebhookService.name, {
        action: 'easyorders-webhook-secret-learn',
        outcome: learned ? 'success' : 'skipped',
        orgId,
        integrationId,
        webhookKind: kind,
      }),
    );
    return 'verified';
  }

  private encryptionKey(): string {
    return this.config.getOrThrow<string>('SHOPIFY_TOKEN_ENCRYPTION_KEY');
  }

  private async accept(
    kind: EasyOrdersWebhookKind,
    connection: EasyOrdersConnection,
    event: {
      jobType: WebhookJobType;
      idempotencyKey: string;
      rawPayload: Record<string, unknown>;
    },
  ): Promise<EasyOrdersWebhookAck> {
    let result: { enqueued: boolean; duplicate?: boolean };
    try {
      // The tenant is the one the URL token resolved to. Nothing in the
      // payload chooses it.
      result = await this.producer.ingest({
        platform: 'easyorders',
        storeDomain: buildEasyOrdersSourceIdentity(connection.orgId),
        ...event,
      });
    } catch (error) {
      // The event is lost unless EasyOrders retries, which is unknown.
      this.logger.error(
        buildBackendLog(EasyOrdersWebhookService.name, {
          action: 'easyorders-webhook-not-persisted',
          outcome: 'failure',
          orgId: connection.orgId,
          integrationId: connection.integrationId,
          webhookKind: kind,
          ...normalizeError(error),
        }),
      );
      throw error;
    }

    this.logger.log(
      buildBackendLog(EasyOrdersWebhookService.name, {
        action: 'easyorders-webhook-accept',
        outcome: result.duplicate ? 'skipped' : 'success',
        orgId: connection.orgId,
        integrationId: connection.integrationId,
        webhookKind: kind,
        queued: result.enqueued,
        ...(result.duplicate ? { reason: 'duplicate_webhook' } : {}),
      }),
    );
    return result.duplicate
      ? { received: true, duplicate: true }
      : { received: true };
  }

  private unauthorized(
    kind: EasyOrdersWebhookKind,
    connection: EasyOrdersConnection | undefined,
    reason: string,
  ) {
    this.logger.warn(
      buildBackendLog(EasyOrdersWebhookService.name, {
        action: 'easyorders-webhook-accept',
        outcome: 'failure',
        orgId: connection?.orgId,
        integrationId: connection?.integrationId,
        webhookKind: kind,
        reason,
        errorCode: 'EASYORDERS_WEBHOOK_UNAUTHORIZED',
      }),
    );
    return easyOrdersError('EASYORDERS_WEBHOOK_UNAUTHORIZED');
  }

  private refuse(
    kind: EasyOrdersWebhookKind,
    connection: EasyOrdersConnection,
    code: 'EASYORDERS_WEBHOOK_STORE_MISMATCH' | 'EASYORDERS_WEBHOOK_MALFORMED',
  ) {
    this.logger.warn(
      buildBackendLog(EasyOrdersWebhookService.name, {
        action: 'easyorders-webhook-accept',
        outcome: 'failure',
        orgId: connection.orgId,
        integrationId: connection.integrationId,
        webhookKind: kind,
        errorCode: code,
      }),
    );
    return easyOrdersError(code);
  }
}
