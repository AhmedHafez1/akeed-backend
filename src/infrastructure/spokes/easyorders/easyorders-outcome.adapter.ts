import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EasyOrdersConnectionsRepository,
  type EasyOrdersConnection,
} from '../../database/repositories/easyorders-connections.repository';
import type {
  CommerceOutcomeAction,
  CommerceOutcomeAdapter,
  CommerceOutcomeAdapterRequest,
  CommerceOutcomeOperationResult,
} from '../../../shared/commerce/commerce-outcome';
import {
  EASYORDERS_CONFIG,
  type EasyOrdersConfig,
} from '../../../shared/config/easyorders.config';
import { buildBackendLog } from '../../../shared/logging/backend-log.util';
import { EasyOrdersApiClient } from './easyorders-api.client';
import { readEasyOrdersApiKey } from './easyorders-credentials';
import {
  EASYORDERS_OUTCOME_ACTIONS,
  EASYORDERS_WRITABLE_FROM_STATUS,
  easyOrdersStatusFor,
  readEasyOrdersStatus,
} from './easyorders-outcome.mapping';
import {
  EasyOrdersRateLimiter,
  msUntilNextMinute,
} from './easyorders-rate-limiter';

/** An inactive store is a health state, retried slowly (section 2). */
const INACTIVE_STORE_RETRY_MS = 5 * 60_000;

const NO_CAPABILITIES: ReadonlySet<CommerceOutcomeAction> = new Set();
const CAPABILITIES: ReadonlySet<CommerceOutcomeAction> = new Set(
  EASYORDERS_OUTCOME_ACTIONS,
);

type Failure = Extract<
  CommerceOutcomeOperationResult,
  { status: 'retryable_failure' | 'permanent_failure' }
>;

/**
 * Writes approved outcomes to EasyOrders as an order status (US-06-04,
 * contract record sections 2, 5 and 8).
 *
 * Every call uses the connection and key of the order's own integration. The
 * order is read before it is written: only `pending` is written from, an order
 * already at the target is reported as done without a write, and any other
 * state is left alone and reported. A write whose answer was lost is read back
 * before anything is tried again. Success is reported only for a state
 * EasyOrders confirmed.
 *
 * Remote writes are off until `EASYORDERS_OUTCOME_SYNC_ENABLED` is set: with
 * the switch off the adapter has no capability, so nothing is requested.
 */
@Injectable()
export class EasyOrdersOutcomeAdapter implements CommerceOutcomeAdapter {
  readonly platformType = 'easyorders';
  readonly requiresActiveConnection = true;
  readonly tracksSynchronization = true;

  private readonly logger = new Logger(EasyOrdersOutcomeAdapter.name);

  constructor(
    private readonly connections: EasyOrdersConnectionsRepository,
    private readonly api: EasyOrdersApiClient,
    private readonly limiter: EasyOrdersRateLimiter,
    private readonly config: ConfigService,
  ) {}

  /** Fails closed: a configuration that was never validated means off. */
  get capabilities(): ReadonlySet<CommerceOutcomeAction> {
    return this.config.get<EasyOrdersConfig>(EASYORDERS_CONFIG)
      ?.outcomeSyncEnabled === true
      ? CAPABILITIES
      : NO_CAPABILITIES;
  }

  async execute(
    request: CommerceOutcomeAdapterRequest,
  ): Promise<CommerceOutcomeOperationResult> {
    const result = await this.synchronize(request);
    this.logger.log(
      buildBackendLog(EasyOrdersOutcomeAdapter.name, {
        action: 'easyorders-outcome-sync',
        outcome:
          result.status === 'applied'
            ? 'success'
            : result.status === 'retryable_failure'
              ? 'retry'
              : 'failure',
        orgId: request.orgId,
        integrationId: request.integrationId,
        commerceAction: request.action,
        correlationId: request.correlationId,
        errorCode: 'errorCode' in result ? result.errorCode : undefined,
        providerStatus:
          'providerStatus' in result ? result.providerStatus : undefined,
      }),
    );
    return result;
  }

  private async synchronize(
    request: CommerceOutcomeAdapterRequest,
  ): Promise<CommerceOutcomeOperationResult> {
    const target = easyOrdersStatusFor(request.action);
    if (!target || !this.capabilities.has(request.action))
      return { status: 'unsupported', reason: 'capability_not_supported' };

    // The order's own integration, never one the request could name freely:
    // the registry has already matched it to the order and the organization.
    const connection = await this.connections.findByIntegration(
      request.integrationId,
      request.orgId,
    );
    if (!connection)
      return { status: 'permanent_failure', errorCode: 'connection_missing' };
    // The registry refuses an inactive source before calling; this covers a
    // disconnect landing between its check and this read.
    if (connection.disconnectedAt)
      return { status: 'permanent_failure', errorCode: 'integration_inactive' };

    const apiKey = this.readApiKey(connection);
    if (!apiKey)
      return {
        status: 'permanent_failure',
        errorCode: 'credentials_unreadable',
        requiresAssistance: true,
      };

    const before = await this.readStatus(
      connection,
      apiKey,
      request.externalOrderId,
    );
    if ('failure' in before) return before.failure;
    if (before.status === target)
      return { status: 'applied', providerStatus: target };
    if (before.status !== EASYORDERS_WRITABLE_FROM_STATUS)
      return {
        status: 'permanent_failure',
        errorCode: 'remote_state_conflict',
        providerStatus: before.status,
      };

    const budget = this.budget(connection.integrationId);
    if (budget) return budget;
    const write = await this.api.updateOrderStatus(
      apiKey,
      request.externalOrderId,
      target,
    );
    switch (write.kind) {
      case 'updated':
        return { status: 'applied', providerStatus: target };
      case 'rate_limited':
        return this.rateLimited(connection.integrationId, write.retryAfterMs);
      case 'credentials_rejected':
        return this.credentialsRejected(connection);
      case 'store_inactive':
        return this.storeInactive(connection);
      case 'not_found':
        return { status: 'permanent_failure', errorCode: 'order_not_found' };
      case 'rejected':
        return { status: 'permanent_failure', errorCode: 'remote_rejected' };
      case 'ambiguous':
        return this.reconcile(
          connection,
          apiKey,
          request.externalOrderId,
          target,
        );
    }
  }

  /** Null for a stored value that is not a key Akeed can use. */
  private readApiKey(connection: EasyOrdersConnection): string | null {
    try {
      return readEasyOrdersApiKey(
        connection,
        this.config.getOrThrow<string>('SHOPIFY_TOKEN_ENCRYPTION_KEY'),
      );
    } catch {
      return null;
    }
  }

  /**
   * The write may or may not have been taken. The order says which: nothing
   * is written again until it has been read.
   */
  private async reconcile(
    connection: EasyOrdersConnection,
    apiKey: string,
    orderId: string,
    target: string,
  ): Promise<CommerceOutcomeOperationResult> {
    const after = await this.readStatus(connection, apiKey, orderId);
    if ('failure' in after)
      return after.failure.status === 'retryable_failure'
        ? { ...after.failure, errorCode: 'write_unconfirmed' }
        : after.failure;
    if (after.status === target)
      return { status: 'applied', providerStatus: target };
    if (after.status === EASYORDERS_WRITABLE_FROM_STATUS)
      return { status: 'retryable_failure', errorCode: 'write_unconfirmed' };
    return {
      status: 'permanent_failure',
      errorCode: 'remote_state_conflict',
      providerStatus: after.status,
    };
  }

  /** One read of the order's current status, inside the rate budget. */
  private async readStatus(
    connection: EasyOrdersConnection,
    apiKey: string,
    orderId: string,
  ): Promise<{ status: string } | { failure: Failure }> {
    const budget = this.budget(connection.integrationId);
    if (budget) return { failure: budget };

    const lookup = await this.api.getOrder(apiKey, orderId);
    switch (lookup.kind) {
      case 'rate_limited':
        return {
          failure: this.rateLimited(
            connection.integrationId,
            lookup.retryAfterMs,
          ),
        };
      case 'unavailable':
        return {
          failure: {
            status: 'retryable_failure',
            errorCode: 'source_unavailable',
          },
        };
      case 'store_inactive':
        return { failure: await this.storeInactive(connection) };
      case 'credentials_rejected':
        return { failure: await this.credentialsRejected(connection) };
      case 'not_found':
        return {
          failure: {
            status: 'permanent_failure',
            errorCode: 'order_not_found',
          },
        };
      case 'found':
        break;
    }

    if (connection.health !== 'ok')
      await this.connections.setHealth(
        connection.integrationId,
        connection.orgId,
        'ok',
      );
    // The response shape is not in the contract record, so this fails closed:
    // an order that does not name this integration's store is not written to.
    if (typeof lookup.order.store_id !== 'string')
      return {
        failure: { status: 'permanent_failure', errorCode: 'store_unverified' },
      };
    if (lookup.order.store_id !== connection.storeId)
      return {
        failure: { status: 'permanent_failure', errorCode: 'store_mismatch' },
      };
    const status = readEasyOrdersStatus(lookup.order.status);
    return status
      ? { status }
      : {
          failure: {
            status: 'permanent_failure',
            errorCode: 'remote_state_unreadable',
          },
        };
  }

  private budget(integrationId: string): Failure | null {
    const decision = this.limiter.acquire(integrationId, 'outcome');
    return decision.allowed
      ? null
      : {
          status: 'retryable_failure',
          errorCode: 'source_rate_budget_exhausted',
          retryAfterMs: decision.retryAfterMs,
        };
  }

  /** A 429 pauses every EasyOrders call of this integration, not only this. */
  private rateLimited(
    integrationId: string,
    retryAfterMs: number | null,
  ): Failure {
    const delayMs = retryAfterMs ?? msUntilNextMinute(Date.now());
    this.limiter.pause(integrationId, delayMs);
    return {
      status: 'retryable_failure',
      errorCode: 'source_rate_limited',
      retryAfterMs: delayMs,
    };
  }

  private async storeInactive(
    connection: EasyOrdersConnection,
  ): Promise<Failure> {
    await this.connections.setHealth(
      connection.integrationId,
      connection.orgId,
      'store_inactive',
    );
    return {
      status: 'retryable_failure',
      errorCode: 'source_store_inactive',
      retryAfterMs: INACTIVE_STORE_RETRY_MS,
    };
  }

  /** 401 or 403: permanent until the merchant acts; never retried. */
  private async credentialsRejected(
    connection: EasyOrdersConnection,
  ): Promise<Failure> {
    await this.connections.setHealth(
      connection.integrationId,
      connection.orgId,
      'credentials_rejected',
    );
    return {
      status: 'permanent_failure',
      errorCode: 'source_credentials_rejected',
      requiresAssistance: true,
    };
  }
}
