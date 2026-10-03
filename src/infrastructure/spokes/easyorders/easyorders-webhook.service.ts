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
import { decryptToken } from '../../../shared/utils/token-encryption.util';
import {
  hashInstallToken,
  isWellFormedInstallToken,
} from './easyorders-install-token';
import { easyOrdersError } from './easyorders.errors';

export type EasyOrdersWebhookKind = 'orders' | 'status';

export interface EasyOrdersWebhookAck {
  received: true;
  duplicate?: true;
}

/** The one event type the status webhook is documented to send. */
export const EASYORDERS_STATUS_EVENT_TYPE = 'order-status-update';

const ID_MAX_LENGTH = 128;
const STATUS_MAX_LENGTH = 64;
/** Printable ASCII without spaces: an id or a status, never free text. */
const OPAQUE_VALUE_PATTERN = /^[\x21-\x7E]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isOpaque(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    OPAQUE_VALUE_PATTERN.test(value)
  );
}

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

/** Source-scoped keys for a provider that sends no delivery id (section 3). */
export function buildOrderCreatedKey(
  integrationId: string,
  orderId: string,
): string {
  return `order.create:${integrationId}:${orderId}`;
}

export function buildOrderStatusKey(
  integrationId: string,
  event: { orderId: string; oldStatus: string; newStatus: string },
): string {
  return `order.status:${integrationId}:${event.orderId}:${event.oldStatus}:${event.newStatus}`;
}

/**
 * EasyOrders webhook ingress (US-06-03).
 *
 * A delivery is accepted only with both factors: the per-install URL token,
 * which alone decides the tenant, and that webhook's `secret` header. An order
 * must also name the store the integration is bound to. Nothing is persisted
 * before all of that holds, and the answer is 200 only after the event row is
 * written: EasyOrders is assumed not to retry.
 */
@Injectable()
export class EasyOrdersWebhookService {
  private readonly logger = new Logger(EasyOrdersWebhookService.name);

  constructor(
    private readonly connections: EasyOrdersConnectionsRepository,
    private readonly producer: WebhookQueueProducer,
    private readonly config: ConfigService,
  ) {}

  async handleOrderCreated(
    token: string,
    secret: unknown,
    body: unknown,
  ): Promise<EasyOrdersWebhookAck> {
    const connection = await this.authenticate('orders', token, secret);
    const payload = isRecord(body) ? body : {};

    if (payload.store_id !== connection.storeId)
      throw this.refuse(
        'orders',
        connection,
        'EASYORDERS_WEBHOOK_STORE_MISMATCH',
      );
    // The order payload has no event type. One that has is another event, and
    // only an order may reach the create path.
    if ('event_type' in payload || !isOpaque(payload.id, ID_MAX_LENGTH))
      throw this.refuse('orders', connection, 'EASYORDERS_WEBHOOK_MALFORMED');

    return this.accept('orders', connection, {
      jobType: WebhookJobType.ORDER_CREATE,
      idempotencyKey: buildOrderCreatedKey(
        connection.integrationId,
        payload.id,
      ),
      rawPayload: payload,
    });
  }

  /**
   * Status events are recorded and nothing else: the worker has no handler
   * for them, so no order is read or changed (US-06-04 owns that).
   */
  async handleStatusUpdate(
    token: string,
    secret: unknown,
    body: unknown,
  ): Promise<EasyOrdersWebhookAck> {
    const connection = await this.authenticate('status', token, secret);
    const payload = isRecord(body) ? body : {};
    const {
      order_id: orderId,
      old_status: oldStatus,
      new_status: newStatus,
    } = payload;

    if (
      payload.event_type !== EASYORDERS_STATUS_EVENT_TYPE ||
      !isOpaque(orderId, ID_MAX_LENGTH) ||
      !isOpaque(oldStatus, STATUS_MAX_LENGTH) ||
      !isOpaque(newStatus, STATUS_MAX_LENGTH)
    )
      throw this.refuse('status', connection, 'EASYORDERS_WEBHOOK_MALFORMED');

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
  ): Promise<EasyOrdersConnection> {
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
    if (!encrypted) throw this.unauthorized(kind, connection, 'secret_not_set');

    let expected: string;
    try {
      expected = decryptToken(
        encrypted,
        this.config.getOrThrow<string>('SHOPIFY_TOKEN_ENCRYPTION_KEY'),
      );
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
    return connection;
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
