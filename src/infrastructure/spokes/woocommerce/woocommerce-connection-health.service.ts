import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  WooCommerceConnectionsRepository,
  type WooCommerceConnection,
  type WooCommerceWebhookStoredState,
} from '../../database/repositories/woocommerce-connections.repository';
import type {
  SourceWebhookHealth,
  SourceWebhookKind,
  SourceWebhookState,
} from '../../../shared/commerce/source-setup';
import { readWooCommerceConfig } from '../../../shared/config/woocommerce.config';
import { buildBackendLog } from '../../../shared/logging/backend-log.util';
import {
  WooCommerceApiClient,
  type WooCommerceCallFailure,
  type WooCommerceCredentials,
} from './woocommerce-api.client';
import { readWooCommerceCredentials } from './woocommerce-credentials';
import {
  canonicalizeWooCommerceStoreUrl,
  wooCommerceStoreHost,
} from './woocommerce-store-url';
import {
  restFailureCode,
  webhookEnableFailureCode,
  wooCommerceError,
  type WooCommerceErrorCode,
} from './woocommerce.errors';

/** A health read waits this long for the store, both webhooks together. */
export const WOOCOMMERCE_HEALTH_BUDGET_MS = 8_000;

/** A connection check or a re-enable, all of its store calls together. */
export const WOOCOMMERCE_CHECK_BUDGET_MS = 20_000;

export type WooCommerceWebhookStates = SourceWebhookHealth['items'];

export interface WooCommerceConnectionCheck {
  checkedAt: string;
  /** What is wrong, most fundamental first. Empty when nothing is. */
  problems: WooCommerceErrorCode[];
  webhooks: WooCommerceWebhookStates;
}

/** What one round of webhook reads found. */
interface WebhookReading {
  checkedAt: string;
  items: WooCommerceWebhookStates;
  /** Why the store could not be asked, when it could not. */
  failure?: WooCommerceCallFailure;
}

const KINDS: readonly SourceWebhookKind[] = ['order_created', 'order_updated'];

const WEBHOOK_PROBLEMS: Partial<
  Record<SourceWebhookState, WooCommerceErrorCode>
> = {
  missing: 'WOOCOMMERCE_WEBHOOK_MISSING',
  disabled: 'WOOCOMMERCE_WEBHOOK_DISABLED',
  paused: 'WOOCOMMERCE_WEBHOOK_PAUSED',
};

function webhookIdOf(
  connection: WooCommerceConnection,
  kind: SourceWebhookKind,
): number | null {
  return kind === 'order_created'
    ? connection.orderCreatedWebhookId
    : connection.orderUpdatedWebhookId;
}

function isStoredState(
  state: SourceWebhookState,
): state is WooCommerceWebhookStoredState {
  return state !== 'unknown';
}

/**
 * The store's side of a WooCommerce connection, read on demand (US-07-05,
 * contract record section 3): the state of Akeed's two webhooks, a connection
 * check that tells the failures apart, and the re-enabling of a webhook the
 * store disabled.
 *
 * There is no background poll. Every call is built from one connection row,
 * found by its integration and organization together, and goes to that row's
 * canonical store URL through the restricted outbound client. What the store
 * answers about the keys is recorded as the connection's health, and each
 * definite webhook state as the last one read.
 */
@Injectable()
export class WooCommerceConnectionHealthService {
  private readonly logger = new Logger(WooCommerceConnectionHealthService.name);

  constructor(
    private readonly connections: WooCommerceConnectionsRepository,
    private readonly api: WooCommerceApiClient,
    private readonly config: ConfigService,
  ) {}

  /**
   * For the health read. Null when the source has no live connection: a
   * disconnected one holds no key to ask with.
   */
  async inspectWebhooks(
    integrationId: string,
    orgId: string,
  ): Promise<SourceWebhookHealth | null> {
    const connection = await this.connections.findByIntegration(
      integrationId,
      orgId,
    );
    if (!connection || connection.disconnectedAt) return null;
    const credentials = this.credentialsOf(connection);
    if (!credentials) return this.unread(connection, 'credentials_unreadable');

    const reading = await this.readWebhooks(
      connection,
      credentials,
      AbortSignal.timeout(WOOCOMMERCE_HEALTH_BUDGET_MS),
    );
    return { checkedAt: reading.checkedAt, items: reading.items };
  }

  /**
   * Asks the store what a merchant would otherwise have to guess: whether the
   * address still answers, whether the keys are accepted and allowed, whether
   * the store still calls itself by the address Akeed holds, and what state
   * each webhook is in. A diagnosis, so it answers even when all is wrong.
   */
  async check(orgId: string): Promise<WooCommerceConnectionCheck> {
    const connection = await this.liveConnection(orgId);
    const credentials = this.credentialsOf(connection);
    if (!credentials) {
      const unread = this.unread(connection, 'credentials_unreadable');
      return {
        checkedAt: unread.checkedAt,
        problems: ['WOOCOMMERCE_CREDENTIALS_REJECTED'],
        webhooks: unread.items,
      };
    }
    const budget = AbortSignal.timeout(WOOCOMMERCE_CHECK_BUDGET_MS);
    const problems: WooCommerceErrorCode[] = [];

    const store = await this.api.readSystemStatus(
      connection.storeUrl,
      credentials,
      budget,
    );
    if (store.kind === 'failed') {
      await this.recordAnswer(connection, store.reason);
      const unread = this.unread(connection, store.reason);
      return this.finishCheck(connection, {
        checkedAt: unread.checkedAt,
        problems: [restFailureCode(store.reason)],
        webhooks: unread.items,
      });
    }
    // The store's own value is compared and dropped: never stored or shown.
    const reported = canonicalizeWooCommerceStoreUrl(store.homeUrl);
    if (!reported.ok || reported.url !== connection.storeUrl)
      problems.push('WOOCOMMERCE_STORE_URL_MISMATCH');

    const reading = await this.readWebhooks(connection, credentials, budget);
    if (reading.failure) problems.push(restFailureCode(reading.failure));
    for (const { state } of reading.items) {
      const problem = WEBHOOK_PROBLEMS[state];
      if (problem && !problems.includes(problem)) problems.push(problem);
    }
    return this.finishCheck(connection, {
      checkedAt: reading.checkedAt,
      problems,
      webhooks: reading.items,
    });
  }

  /**
   * Sets every webhook the store disabled back to active, then reads them
   * again: success is what the store shows, not that it answered. A webhook
   * the merchant paused is theirs and is left alone; one that is gone cannot
   * be brought back here, only by reconnecting.
   *
   * Refused while ingestion is off: a re-enabled webhook would get a 404 for
   * its next order, and the store may disable it again on that one answer
   * (finding 3.17).
   */
  async enableWebhooks(orgId: string): Promise<WooCommerceWebhookStates> {
    if (!readWooCommerceConfig(this.config).ingestionEnabled)
      throw this.refuseEnable(orgId, 'WOOCOMMERCE_WEBHOOK_ENABLE_UNAVAILABLE');
    const connection = await this.liveConnection(orgId);
    const credentials = this.credentialsOf(connection);
    if (!credentials)
      throw this.refuseEnable(
        orgId,
        'WOOCOMMERCE_CREDENTIALS_REJECTED',
        connection,
      );
    const budget = AbortSignal.timeout(WOOCOMMERCE_CHECK_BUDGET_MS);

    const before = await this.readWebhooks(connection, credentials, budget);
    if (before.failure)
      throw this.refuseEnable(
        orgId,
        webhookEnableFailureCode(before.failure),
        connection,
      );
    if (before.items.some((item) => item.state === 'missing'))
      throw this.refuseEnable(orgId, 'WOOCOMMERCE_WEBHOOK_MISSING', connection);

    const disabled = before.items.filter((item) => item.state === 'disabled');
    for (const { kind } of disabled) {
      const webhookId = webhookIdOf(connection, kind);
      if (webhookId === null) continue;
      const written = await this.api.enableWebhook(
        connection.storeUrl,
        credentials,
        webhookId,
        budget,
      );
      if (written.kind === 'ok') continue;
      if (written.kind === 'failed')
        await this.recordAnswer(connection, written.reason);
      throw this.refuseEnable(
        orgId,
        written.kind === 'missing'
          ? 'WOOCOMMERCE_WEBHOOK_MISSING'
          : webhookEnableFailureCode(written.reason),
        connection,
      );
    }
    if (disabled.length === 0) return before.items;

    const after = await this.readWebhooks(connection, credentials, budget);
    const confirmed = disabled.every(
      ({ kind }) =>
        after.items.find((item) => item.kind === kind)?.state === 'active',
    );
    if (!confirmed)
      throw this.refuseEnable(
        orgId,
        after.failure
          ? webhookEnableFailureCode(after.failure)
          : 'WOOCOMMERCE_WEBHOOK_ENABLE_FAILED',
        connection,
      );

    this.logger.log(
      buildBackendLog(WooCommerceConnectionHealthService.name, {
        action: 'woocommerce-webhook-enable',
        outcome: 'success',
        orgId,
        integrationId: connection.integrationId,
        storeHost: wooCommerceStoreHost(connection.storeUrl),
        enabledCount: disabled.length,
      }),
    );
    return after.items;
  }

  /** The organization's own connection, while it is connected. */
  private async liveConnection(orgId: string): Promise<WooCommerceConnection> {
    const connection = await this.connections.findByOrganization(orgId);
    if (!connection || connection.disconnectedAt)
      throw wooCommerceError('WOOCOMMERCE_NOT_CONNECTED');
    return connection;
  }

  private credentialsOf(
    connection: WooCommerceConnection,
  ): WooCommerceCredentials | null {
    return readWooCommerceCredentials(
      connection,
      this.config.getOrThrow<string>('SHOPIFY_TOKEN_ENCRYPTION_KEY'),
    );
  }

  /**
   * Both webhooks, read at the same time. A 404 is the webhook's own answer:
   * the keys were accepted to get it, so it counts as the store taking them.
   */
  private async readWebhooks(
    connection: WooCommerceConnection,
    credentials: WooCommerceCredentials,
    signal: AbortSignal,
  ): Promise<WebhookReading> {
    const answers = await Promise.all(
      KINDS.map(async (kind) => {
        const webhookId = webhookIdOf(connection, kind);
        return {
          kind,
          answer:
            webhookId === null
              ? ({ kind: 'missing' } as const)
              : await this.api.getWebhook(
                  connection.storeUrl,
                  credentials,
                  webhookId,
                  signal,
                ),
        };
      }),
    );
    const checkedAt = new Date().toISOString();
    const items: WooCommerceWebhookStates = answers.map(({ kind, answer }) => ({
      kind,
      state:
        answer.kind === 'found'
          ? (answer.status ?? 'unknown')
          : answer.kind === 'missing'
            ? 'missing'
            : 'unknown',
    }));
    const failures = answers.flatMap(({ answer }) =>
      answer.kind === 'failed' ? [answer.reason] : [],
    );
    // A refused key outranks any other reason the two reads may give.
    const failure =
      failures.find(
        (reason) =>
          reason === 'credentials_rejected' || reason === 'permission_denied',
      ) ?? failures[0];

    if (failure) await this.recordAnswer(connection, failure);
    else await this.recordAnswer(connection, 'accepted');

    const stateOf = (kind: SourceWebhookKind) => {
      const state = items.find((item) => item.kind === kind)?.state;
      return state && isStoredState(state) ? state : undefined;
    };
    await this.connections.recordWebhookStates(
      connection.integrationId,
      connection.orgId,
      {
        orderCreated: stateOf('order_created'),
        orderUpdated: stateOf('order_updated'),
      },
      checkedAt,
    );

    if (failure)
      this.logger.warn(
        buildBackendLog(WooCommerceConnectionHealthService.name, {
          action: 'woocommerce-webhook-read',
          outcome: 'failure',
          orgId: connection.orgId,
          integrationId: connection.integrationId,
          storeHost: wooCommerceStoreHost(connection.storeUrl),
          reason: failure,
        }),
      );
    return { checkedAt, items, ...(failure ? { failure } : {}) };
  }

  /**
   * What the store's answer says of the keys (worst-case rule for findings
   * 2.6 and 2.8): 401 is rejected, 403 is denied, an answer that needed the
   * keys to be given clears either. Anything else says nothing about them.
   */
  private async recordAnswer(
    connection: WooCommerceConnection,
    answer: WooCommerceCallFailure | 'accepted',
  ): Promise<void> {
    const health =
      answer === 'accepted'
        ? 'ok'
        : answer === 'credentials_rejected' || answer === 'permission_denied'
          ? answer
          : undefined;
    if (!health || connection.health === health) return;
    await this.connections.setHealth(
      connection.integrationId,
      connection.orgId,
      health,
    );
    // One request can get more than one answer (a read that is accepted,
    // then a write that is refused): the next one is compared with what was
    // just written, not with the row as it was loaded.
    connection.health = health;
  }

  /** Both webhooks as not read, with the reason logged. */
  private unread(
    connection: WooCommerceConnection,
    reason: string,
  ): { checkedAt: string; items: WooCommerceWebhookStates } {
    this.logger.warn(
      buildBackendLog(WooCommerceConnectionHealthService.name, {
        action: 'woocommerce-webhook-read',
        outcome: 'skipped',
        orgId: connection.orgId,
        integrationId: connection.integrationId,
        storeHost: wooCommerceStoreHost(connection.storeUrl),
        reason,
      }),
    );
    return {
      checkedAt: new Date().toISOString(),
      items: KINDS.map((kind) => ({ kind, state: 'unknown' })),
    };
  }

  private finishCheck(
    connection: WooCommerceConnection,
    check: WooCommerceConnectionCheck,
  ): WooCommerceConnectionCheck {
    this.logger.log(
      buildBackendLog(WooCommerceConnectionHealthService.name, {
        action: 'woocommerce-connection-check',
        outcome: check.problems.length === 0 ? 'success' : 'failure',
        orgId: connection.orgId,
        integrationId: connection.integrationId,
        storeHost: wooCommerceStoreHost(connection.storeUrl),
        problems: check.problems,
      }),
    );
    return check;
  }

  private refuseEnable(
    orgId: string,
    code: WooCommerceErrorCode,
    connection?: WooCommerceConnection,
  ) {
    this.logger.warn(
      buildBackendLog(WooCommerceConnectionHealthService.name, {
        action: 'woocommerce-webhook-enable',
        outcome: 'failure',
        orgId,
        integrationId: connection?.integrationId,
        storeHost: connection
          ? wooCommerceStoreHost(connection.storeUrl)
          : undefined,
        errorCode: code,
      }),
    );
    return wooCommerceError(code);
  }
}
