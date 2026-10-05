import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  WooCommerceConnectionsRepository,
  type WooCommerceConnection,
} from '../../database/repositories/woocommerce-connections.repository';
import type {
  CommerceOutcomeAction,
  CommerceOutcomeAdapter,
  CommerceOutcomeAdapterRequest,
  CommerceOutcomeOperationResult,
} from '../../../shared/commerce/commerce-outcome';
import {
  WOOCOMMERCE_CONFIG,
  type WooCommerceConfig,
} from '../../../shared/config/woocommerce.config';
import { buildBackendLog } from '../../../shared/logging/backend-log.util';
import {
  WooCommerceApiClient,
  type WooCommerceCredentials,
  type WooCommerceOrderCallFailure,
  type WooCommerceOrderState,
} from './woocommerce-api.client';
import { readWooCommerceCredentials } from './woocommerce-credentials';
import {
  buildWooCommerceOutcomeMarker,
  WOOCOMMERCE_CONFIRMATION_NOTE,
  WOOCOMMERCE_OUTCOME_ACTIONS,
  WOOCOMMERCE_WRITABLE_FROM_STATUSES,
  wooCommerceEffectFor,
  type WooCommerceOutcomeEffect,
} from './woocommerce-outcome.mapping';
import { wooCommerceStoreHost } from './woocommerce-store-url';

const NO_CAPABILITIES: ReadonlySet<CommerceOutcomeAction> = new Set();
const CAPABILITIES: ReadonlySet<CommerceOutcomeAction> = new Set(
  WOOCOMMERCE_OUTCOME_ACTIONS,
);

type Failure = Extract<
  CommerceOutcomeOperationResult,
  { status: 'retryable_failure' | 'permanent_failure' }
>;

/** One outcome on its way to one order of one store. */
interface Target {
  connection: WooCommerceConnection;
  credentials: WooCommerceCredentials;
  orderId: string;
  effect: WooCommerceOutcomeEffect;
  marker: string;
}

/** What an order's current state means for the outcome: done, or to write. */
type Decision =
  | { write: true }
  | { write: false; result: CommerceOutcomeOperationResult };

/**
 * Writes approved outcomes to a WooCommerce store (US-07-04, contract record
 * sections 5 and 8).
 *
 * Every call uses the connection and keys of the order's own integration,
 * through the restricted outbound client. The order is read before it is
 * written: only `processing` and `on-hold` are written from, an order that
 * already shows the outcome is reported as done without a write, and any
 * other state is left alone and reported. The marker and the status travel in
 * one update, so a repeat cannot leave one without the other; the note is
 * added only when the read showed no marker. A write whose answer was lost is
 * read back before anything is tried again. Success is reported only for a
 * state the store confirmed.
 *
 * Remote writes are off until `WOOCOMMERCE_OUTCOME_SYNC_ENABLED` is set: with
 * the switch off the adapter has no capability, so nothing is requested.
 */
@Injectable()
export class WooCommerceOutcomeAdapter implements CommerceOutcomeAdapter {
  readonly platformType = 'woocommerce';
  readonly requiresActiveConnection = true;
  readonly tracksSynchronization = true;

  private readonly logger = new Logger(WooCommerceOutcomeAdapter.name);

  constructor(
    private readonly connections: WooCommerceConnectionsRepository,
    private readonly api: WooCommerceApiClient,
    private readonly config: ConfigService,
  ) {}

  /** Fails closed: a configuration that was never validated means off. */
  get capabilities(): ReadonlySet<CommerceOutcomeAction> {
    return this.config.get<WooCommerceConfig>(WOOCOMMERCE_CONFIG)
      ?.outcomeSyncEnabled === true
      ? CAPABILITIES
      : NO_CAPABILITIES;
  }

  async execute(
    request: CommerceOutcomeAdapterRequest,
  ): Promise<CommerceOutcomeOperationResult> {
    const result = await this.synchronize(request);
    this.logger.log(
      buildBackendLog(WooCommerceOutcomeAdapter.name, {
        action: 'woocommerce-outcome-sync',
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
    const effect = wooCommerceEffectFor(request.action);
    if (!effect || !this.capabilities.has(request.action))
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

    const credentials = this.readCredentials(connection);
    if (!credentials)
      return {
        status: 'permanent_failure',
        errorCode: 'credentials_unreadable',
        requiresAssistance: true,
      };

    const target: Target = {
      connection,
      credentials,
      orderId: request.externalOrderId,
      effect,
      marker: buildWooCommerceOutcomeMarker(
        request.action,
        request.correlationId,
      ),
    };

    const before = await this.readOrder(target);
    if ('failure' in before) return before.failure;
    const decision = this.decide(target, before.order);
    if (!decision.write) return decision.result;

    const write = await this.api.updateOrder(
      connection.storeUrl,
      credentials,
      target.orderId,
      { marker: target.marker, status: effect.status },
    );
    switch (write.kind) {
      case 'updated': {
        // Success is what the answer shows, not that there was one.
        const after = this.decide(target, write.order);
        return after.write || after.result.status !== 'applied'
          ? this.reconcile(target)
          : this.finish(target, after.result);
      }
      case 'ambiguous':
        return this.reconcile(target);
      case 'rejected':
        return { status: 'permanent_failure', errorCode: 'remote_rejected' };
      case 'method_refused':
        // The host refuses `PUT` (rule 8.4): outside the support boundary.
        return {
          status: 'permanent_failure',
          errorCode: 'store_write_method_refused',
          requiresAssistance: true,
        };
      default:
        return this.failed(connection, write);
    }
  }

  /** Null for a stored value that is not a key Akeed can use. */
  private readCredentials(
    connection: WooCommerceConnection,
  ): WooCommerceCredentials | null {
    try {
      return readWooCommerceCredentials(
        connection,
        this.config.getOrThrow<string>('SHOPIFY_TOKEN_ENCRYPTION_KEY'),
      );
    } catch {
      return null;
    }
  }

  /**
   * The decision table of the contract record, section 5. A cancellation is
   * done when the order is cancelled; a confirmation, which changes no
   * status, when its marker is there. Otherwise only `processing` and
   * `on-hold` are written from.
   *
   * A cancellation whose marker is there on an order that is not cancelled
   * was taken and then undone in the store. It is a conflict, not a reason to
   * cancel the order a second time.
   */
  private decide(target: Target, order: WooCommerceOrderState): Decision {
    const { effect, marker } = target;
    const marked = order.markers.includes(marker);
    const providerStatus = order.status ?? undefined;
    if (effect.status ? order.status === effect.status : marked)
      return { write: false, result: { status: 'applied', providerStatus } };
    if (
      marked ||
      order.status === null ||
      !WOOCOMMERCE_WRITABLE_FROM_STATUSES.has(order.status)
    )
      return {
        write: false,
        result: {
          status: 'permanent_failure',
          errorCode: 'remote_state_conflict',
          providerStatus,
        },
      };
    return { write: true };
  }

  /**
   * The write may or may not have been taken. The order says which: nothing
   * is written again until it has been read.
   */
  private async reconcile(
    target: Target,
  ): Promise<CommerceOutcomeOperationResult> {
    const after = await this.readOrder(target);
    if ('failure' in after)
      return after.failure.status === 'retryable_failure'
        ? { ...after.failure, errorCode: 'write_unconfirmed' }
        : after.failure;
    const decision = this.decide(target, after.order);
    if (decision.write)
      return { status: 'retryable_failure', errorCode: 'write_unconfirmed' };
    return decision.result.status === 'applied'
      ? this.finish(target, decision.result)
      : decision.result;
  }

  /**
   * Called once the store has shown a write this run made, and only then: the
   * first read showed no marker, so no earlier run can have added the note.
   * A later run sees the marker and never reaches this.
   *
   * Notes cannot be made idempotent (finding 5.6), so a note that fails is
   * logged and not tried again: the marker is the record.
   */
  private async finish(
    target: Target,
    result: CommerceOutcomeOperationResult,
  ): Promise<CommerceOutcomeOperationResult> {
    if (!target.effect.note) return result;
    const { connection } = target;
    const added = await this.api.addOrderNote(
      connection.storeUrl,
      target.credentials,
      target.orderId,
      WOOCOMMERCE_CONFIRMATION_NOTE,
    );
    if (!added)
      this.logger.warn(
        buildBackendLog(WooCommerceOutcomeAdapter.name, {
          action: 'woocommerce-outcome-note',
          outcome: 'failure',
          orgId: connection.orgId,
          integrationId: connection.integrationId,
          storeHost: wooCommerceStoreHost(connection.storeUrl),
          reason: 'note_not_added',
        }),
      );
    return result;
  }

  /** One read of the order, proven to be this store's. */
  private async readOrder(
    target: Target,
  ): Promise<{ order: WooCommerceOrderState } | { failure: Failure }> {
    const { connection } = target;
    const lookup = await this.api.getOrder(
      connection.storeUrl,
      target.credentials,
      target.orderId,
    );
    if (lookup.kind === 'unverified')
      // Fails closed: an answer that does not name this store's order is not
      // written to.
      return {
        failure: { status: 'permanent_failure', errorCode: 'store_unverified' },
      };
    if (lookup.kind !== 'found')
      return { failure: await this.failed(connection, lookup) };

    if (connection.health !== 'ok')
      await this.connections.setHealth(
        connection.integrationId,
        connection.orgId,
        'ok',
      );
    return { order: lookup.order };
  }

  /** The failure mapping of the contract record, section 5. */
  private async failed(
    connection: WooCommerceConnection,
    failure: WooCommerceOrderCallFailure,
  ): Promise<Failure> {
    switch (failure.kind) {
      // 401 and 403 are permanent until the merchant acts; never retried.
      case 'credentials_rejected':
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
      case 'permission_denied':
        await this.connections.setHealth(
          connection.integrationId,
          connection.orgId,
          'permission_denied',
        );
        return {
          status: 'permanent_failure',
          errorCode: 'source_permission_denied',
          requiresAssistance: true,
        };
      case 'not_found':
        return { status: 'permanent_failure', errorCode: 'order_not_found' };
      case 'throttled':
        // A wait the answer named is honored without spending an attempt;
        // without one the existing backoff applies (rule 8.1).
        return {
          status: 'retryable_failure',
          errorCode:
            failure.status === 429
              ? 'source_rate_limited'
              : 'source_unavailable',
          ...(failure.retryAfterMs === null
            ? {}
            : { retryAfterMs: failure.retryAfterMs }),
        };
      case 'unavailable':
        return { status: 'retryable_failure', errorCode: 'source_unavailable' };
      case 'refused':
        return {
          status: 'permanent_failure',
          errorCode: 'store_unreachable',
          requiresAssistance: true,
        };
    }
  }
}
