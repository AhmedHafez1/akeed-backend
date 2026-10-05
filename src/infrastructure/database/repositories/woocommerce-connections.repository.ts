import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  desc,
  eq,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../index';
import { DRIZZLE } from '../database.provider';
import {
  integrations,
  organizations,
  woocommerceConnections,
  woocommercePendingInstalls,
} from '../schema';
import {
  STANDALONE_BILLING_STATUS,
  STANDALONE_DEFAULT_PLAN_ID,
} from '../../../shared/billing/billing-plan';
import {
  databaseErrorCode,
  withSerializableRetry,
} from '../../../shared/database/serializable-retry';
import { STANDALONE_SOURCE_DEFAULTS } from './standalone-organization-provisioning.repository';

type Database = PostgresJsDatabase<typeof schema>;

export type WooCommercePendingInstall =
  typeof woocommercePendingInstalls.$inferSelect;
export type WooCommerceConnection = typeof woocommerceConnections.$inferSelect;

/** The values `woocommerce_connections_health_check` allows. */
export type WooCommerceConnectionHealthState =
  | 'ok'
  | 'credentials_rejected'
  | 'permission_denied';

/** A context that failed this many callbacks is dead; the merchant starts again. */
export const WOOCOMMERCE_MAX_CALLBACK_ATTEMPTS = 5;

/**
 * How long one callback holds an install. Longer than the callback's own
 * budget, so a claim outlives its holder only when the process died.
 */
export const WOOCOMMERCE_CALLBACK_CLAIM_SECONDS = 45;

/** Longest store name the WhatsApp template variable takes. */
const STORE_NAME_MAX_LENGTH = 60;

const VERIFIED_STORE_INDEX = 'woocommerce_connections_verified_store_key';

export function buildWooCommerceSourceIdentity(orgId: string): string {
  return `woocommerce:${orgId}`;
}

/**
 * Whether a context can still be consumed: unused, not replaced by a newer
 * one, not expired and not exhausted.
 */
export function isUsablePendingInstall(
  pending: Pick<
    WooCommercePendingInstall,
    'consumedAt' | 'supersededAt' | 'expiresAt' | 'attempts'
  >,
  now: Date,
): boolean {
  return (
    pending.consumedAt === null &&
    pending.supersededAt === null &&
    pending.attempts < WOOCOMMERCE_MAX_CALLBACK_ATTEMPTS &&
    new Date(pending.expiresAt).getTime() > now.getTime()
  );
}

export interface NewWooCommercePendingInstall {
  orgId: string;
  createdBy: string;
  /** Canonical form; the only store URL any later request is built from. */
  storeUrl: string;
  callbackTokenHash: string;
  installReference: string;
  expiresAt: string;
}

export type CreateWooCommercePendingInstallResult =
  | { kind: 'created'; pending: WooCommercePendingInstall }
  | { kind: 'source_exists' }
  /** A reconnect naming another store than the one that was connected. */
  | { kind: 'store_mismatch' };

/** What the store last answered for a webhook; `woocommerce_connections_webhook_state_check`. */
export type WooCommerceWebhookStoredState =
  | 'active'
  | 'paused'
  | 'disabled'
  | 'missing';

/**
 * What an organization's sources allow: a first connect, a reconnect of its
 * own disconnected WooCommerce source, or nothing. Any other source, active
 * or not, is `taken`: there is no source switching.
 */
export type WooCommerceSourceSlot =
  | { kind: 'fresh' }
  | { kind: 'reconnect'; connection: WooCommerceConnection }
  | { kind: 'taken' };

export interface ConnectWooCommerceInput {
  pendingInstallId: string;
  /** The token this callback registered; it must still be the install's. */
  webhookTokenHash: string;
  /** Ciphertext from `encryptToken`; the repository never sees a key. */
  consumerKeyEncrypted: string;
  consumerSecretEncrypted: string;
  webhookSecretEncrypted: string;
  orderCreatedWebhookId: number;
  orderUpdatedWebhookId: number;
  wooVersion: string | null;
}

export type ConnectWooCommerceResult =
  | {
      kind: 'connected';
      orgId: string;
      integrationId: string;
      /** True when a disconnected source was brought back in place. */
      reconnected: boolean;
    }
  | { kind: 'context_invalid' }
  | { kind: 'source_exists'; orgId: string }
  | { kind: 'store_unavailable'; orgId: string }
  /** A reconnect naming another store than the one that was connected. */
  | { kind: 'store_mismatch'; orgId: string };

export type DisconnectWooCommerceResult =
  | {
      kind: 'disconnected';
      integrationId: string;
      /**
       * The row as it was under the lock, before the wipe: the only place the
       * ciphertexts and webhook ids still exist, for the store cleanup.
       */
      previous: WooCommerceConnection;
    }
  | { kind: 'already_disconnected'; integrationId: string }
  | { kind: 'not_connected' };

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface WooCommerceConnectionOverview {
  organizationName: string | null;
  /** Platform types of every source the organization has, active or not. */
  sourcePlatforms: string[];
  connection: WooCommerceConnection | undefined;
  latestPending: WooCommercePendingInstall | undefined;
}

/** Walks the `cause` chain, because drivers nest the original error. */
function violatedConstraint(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { constraint_name?: unknown; cause?: unknown };
  return typeof candidate.constraint_name === 'string'
    ? candidate.constraint_name
    : violatedConstraint(candidate.cause);
}

@Injectable()
export class WooCommerceConnectionsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Opens an install context for a source-less organization, or for one whose
   * only source is its own disconnected WooCommerce one and only for the
   * store that was connected, and retires its earlier open ones, so at most
   * one context per organization can connect.
   * The organization row is locked, so a callback finishing at the same time
   * is seen either before or after, never half-way.
   *
   * It takes the organization and then the open contexts, the reverse of
   * `connect`, so a callback in flight can deadlock with it. Nothing was
   * committed by the aborted side, so the whole transaction is run again.
   */
  async createPendingInstall(
    input: NewWooCommercePendingInstall,
  ): Promise<CreateWooCommercePendingInstallResult> {
    return withSerializableRetry(() =>
      this.db.transaction(async (tx) => {
        await tx
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.id, input.orgId))
          .for('update');
        const slot = await this.readSlot(tx, input.orgId);
        if (slot.kind === 'taken') return { kind: 'source_exists' as const };
        if (
          slot.kind === 'reconnect' &&
          slot.connection.storeUrl !== input.storeUrl
        )
          return { kind: 'store_mismatch' as const };

        await tx
          .update(woocommercePendingInstalls)
          .set({ supersededAt: sql`now()` })
          .where(
            and(
              eq(woocommercePendingInstalls.orgId, input.orgId),
              isNull(woocommercePendingInstalls.consumedAt),
              isNull(woocommercePendingInstalls.supersededAt),
            ),
          );
        const [pending] = await tx
          .insert(woocommercePendingInstalls)
          .values(input)
          .returning();
        return { kind: 'created' as const, pending };
      }),
    );
  }

  /**
   * The one lookup that is not scoped by organization: the callback is
   * unauthenticated and the token's hash is what binds it to a tenant.
   */
  async findPendingByCallbackTokenHash(
    callbackTokenHash: string,
  ): Promise<WooCommercePendingInstall | undefined> {
    const [pending] = await this.db
      .select()
      .from(woocommercePendingInstalls)
      .where(
        eq(woocommercePendingInstalls.callbackTokenHash, callbackTokenHash),
      )
      .limit(1);
    return pending;
  }

  async findPendingById(
    pendingInstallId: string,
  ): Promise<WooCommercePendingInstall | undefined> {
    const [pending] = await this.db
      .select()
      .from(woocommercePendingInstalls)
      .where(eq(woocommercePendingInstalls.id, pendingInstallId))
      .limit(1);
    return pending;
  }

  /**
   * Takes the install for one callback. The store calls that follow replace
   * the store's Akeed webhooks, and two callbacks doing that at once would
   * delete each other's. One statement, so only one of them gets the row.
   */
  async claimPendingInstall(pendingInstallId: string): Promise<boolean> {
    const claimed = await this.db
      .update(woocommercePendingInstalls)
      .set({
        claimedUntil: sql`now() + make_interval(secs => ${WOOCOMMERCE_CALLBACK_CLAIM_SECONDS})`,
      })
      .where(
        and(
          eq(woocommercePendingInstalls.id, pendingInstallId),
          isNull(woocommercePendingInstalls.consumedAt),
          isNull(woocommercePendingInstalls.supersededAt),
          or(
            isNull(woocommercePendingInstalls.claimedUntil),
            lte(woocommercePendingInstalls.claimedUntil, sql`now()`),
          ),
        ),
      )
      .returning({ id: woocommercePendingInstalls.id });
    return claimed.length > 0;
  }

  /**
   * Records the delivery URL token a callback is about to register at the
   * store. Written before the webhooks are created, so the ping the store
   * sends when one is saved finds a token Akeed knows. Only the claim holder
   * calls this, and a retried callback replaces the hash with its own.
   */
  async setPendingWebhookTokenHash(
    pendingInstallId: string,
    webhookTokenHash: string,
  ): Promise<void> {
    await this.db
      .update(woocommercePendingInstalls)
      .set({ webhookTokenHash })
      .where(
        and(
          eq(woocommercePendingInstalls.id, pendingInstallId),
          isNull(woocommercePendingInstalls.consumedAt),
        ),
      );
  }

  /** Gives the install back without counting an attempt. */
  async releasePendingInstall(pendingInstallId: string): Promise<void> {
    await this.db
      .update(woocommercePendingInstalls)
      .set({ claimedUntil: null })
      .where(eq(woocommercePendingInstalls.id, pendingInstallId));
  }

  /** Counts a refused callback and gives the install back for a retry. */
  async recordFailedAttempt(
    pendingInstallId: string,
    errorCode: string,
  ): Promise<void> {
    await this.db
      .update(woocommercePendingInstalls)
      .set({
        attempts: sql`${woocommercePendingInstalls.attempts} + 1`,
        lastErrorCode: errorCode,
        claimedUntil: null,
      })
      .where(eq(woocommercePendingInstalls.id, pendingInstallId));
  }

  /** A verified store belongs to one integration. */
  async isStoreVerifiedForAnotherOrganization(
    storeUrl: string,
    orgId: string,
  ): Promise<boolean> {
    const [taken] = await this.db
      .select({ integrationId: woocommerceConnections.integrationId })
      .from(woocommerceConnections)
      .where(
        and(
          eq(woocommerceConnections.storeUrl, storeUrl),
          isNotNull(woocommerceConnections.storeVerifiedAt),
          ne(woocommerceConnections.orgId, orgId),
        ),
      )
      .limit(1);
    return Boolean(taken);
  }

  /**
   * Consumes the context and provisions the source in one transaction: the
   * `woocommerce` integration with the pilot entitlement and the onboarding
   * defaults, and its credentials. Either all of it is stored or none.
   *
   * A disconnected source is brought back in place instead (US-07-05): the
   * same integration row, so its orders and history stay attached, with new
   * keys, a new delivery token and the webhooks this callback created. The
   * store must be the one that was connected, and `connected_at` moves to
   * now, so an order placed while disconnected never starts a verification.
   *
   * Locks the context first, then the organization, so two callbacks on one
   * link and two links for one organization both serialize; the loser sees a
   * consumed context or an existing source and changes nothing. The partial
   * unique indexes on active sources and on verified stores are the backstop.
   */
  async connect(
    input: ConnectWooCommerceInput,
    now = new Date(),
  ): Promise<ConnectWooCommerceResult> {
    try {
      return await withSerializableRetry(() =>
        this.db.transaction((tx) => this.connectInTransaction(tx, input, now)),
      );
    } catch (error) {
      if (databaseErrorCode(error) !== '23505') throw error;
      const pending = await this.findPendingById(input.pendingInstallId);
      if (!pending) return { kind: 'context_invalid' };
      return violatedConstraint(error) === VERIFIED_STORE_INDEX
        ? { kind: 'store_unavailable', orgId: pending.orgId }
        : { kind: 'source_exists', orgId: pending.orgId };
    }
  }

  private async connectInTransaction(
    tx: Transaction,
    input: ConnectWooCommerceInput,
    now: Date,
  ): Promise<ConnectWooCommerceResult> {
    const [pending] = await tx
      .select()
      .from(woocommercePendingInstalls)
      .where(eq(woocommercePendingInstalls.id, input.pendingInstallId))
      .for('update');
    if (
      !pending ||
      !isUsablePendingInstall(pending, now) ||
      // Another callback registered its own token since: the webhooks this
      // one created are no longer the install's.
      pending.webhookTokenHash !== input.webhookTokenHash
    )
      return { kind: 'context_invalid' };
    const { orgId } = pending;

    const [organization] = await tx
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .for('update');
    if (!organization) return { kind: 'context_invalid' };

    const slot = await this.readSlot(tx, orgId, { lock: true });
    if (slot.kind === 'taken') return { kind: 'source_exists', orgId };
    if (
      slot.kind === 'reconnect' &&
      slot.connection.storeUrl !== pending.storeUrl
    )
      return { kind: 'store_mismatch', orgId };

    // A disconnected row holds no verified slot, so any verified row for
    // this store is another organization's.
    const [verifiedElsewhere] = await tx
      .select({ integrationId: woocommerceConnections.integrationId })
      .from(woocommerceConnections)
      .where(
        and(
          eq(woocommerceConnections.storeUrl, pending.storeUrl),
          isNotNull(woocommerceConnections.storeVerifiedAt),
        ),
      )
      .limit(1);
    if (verifiedElsewhere) return { kind: 'store_unavailable', orgId };

    const timestamp = now.toISOString();
    const credentials = {
      storeVerifiedAt: timestamp,
      consumerKeyEncrypted: input.consumerKeyEncrypted,
      consumerSecretEncrypted: input.consumerSecretEncrypted,
      webhookSecretEncrypted: input.webhookSecretEncrypted,
      webhookTokenHash: input.webhookTokenHash,
      orderCreatedWebhookId: input.orderCreatedWebhookId,
      orderUpdatedWebhookId: input.orderUpdatedWebhookId,
      // Both were created `active` a moment ago, by this callback.
      orderCreatedWebhookState: 'active',
      orderUpdatedWebhookState: 'active',
      webhooksCheckedAt: timestamp,
      wooVersion: input.wooVersion,
      connectedBy: pending.createdBy,
      connectedAt: timestamp,
    };
    const consumed = {
      consumedAt: timestamp,
      lastErrorCode: null,
      claimedUntil: null,
    };

    if (slot.kind === 'reconnect') {
      const { integrationId } = slot.connection;
      await tx
        .update(integrations)
        .set({ isActive: true, updatedAt: timestamp })
        .where(
          and(
            eq(integrations.id, integrationId),
            eq(integrations.orgId, orgId),
          ),
        );
      await tx
        .update(woocommerceConnections)
        .set({
          ...credentials,
          disconnectedAt: null,
          disconnectedBy: null,
          health: 'ok',
          rejectedDeliveries: 0,
          lastRejectedAt: null,
          updatedAt: timestamp,
        })
        .where(
          and(
            eq(woocommerceConnections.integrationId, integrationId),
            eq(woocommerceConnections.orgId, orgId),
          ),
        );
      await tx
        .update(woocommercePendingInstalls)
        .set(consumed)
        .where(eq(woocommercePendingInstalls.id, pending.id));
      return { kind: 'connected', orgId, integrationId, reconnected: true };
    }

    const [integration] = await tx
      .insert(integrations)
      .values({
        orgId,
        platformType: 'woocommerce',
        // The source identity is the organization, not the store: it keeps
        // merchant-supplied text out of the platform/store uniqueness key
        // and out of `webhook_events.store_domain`.
        platformStoreUrl: buildWooCommerceSourceIdentity(orgId),
        accessToken: null,
        webhookSecret: null,
        isActive: true,
        ...STANDALONE_SOURCE_DEFAULTS,
        // Every order states its payment method; a missing one is unknown,
        // not cash on delivery (contract record section 4).
        assumeCodWhenPaymentMissing: false,
        storeName:
          organization.name.trim().slice(0, STORE_NAME_MAX_LENGTH).trim() ||
          null,
        onboardingStatus: 'pending',
        // The EasyOrders pilot entitlement (product decision 6). Prepaid
        // credits are a Standalone-only accounting mode.
        billingStatus: STANDALONE_BILLING_STATUS,
        billingPlanId: STANDALONE_DEFAULT_PLAN_ID,
        billingActivatedAt: timestamp,
        billingStatusUpdatedAt: timestamp,
      })
      .returning({ id: integrations.id });

    await tx.insert(woocommerceConnections).values({
      integrationId: integration.id,
      orgId,
      // From the context, never from the callback: the keys were proven
      // against this URL and the store reported itself by it.
      storeUrl: pending.storeUrl,
      ...credentials,
    });

    await tx
      .update(woocommercePendingInstalls)
      .set(consumed)
      .where(eq(woocommercePendingInstalls.id, pending.id));

    return {
      kind: 'connected',
      orgId,
      integrationId: integration.id,
      reconnected: false,
    };
  }

  /**
   * What the organization's sources allow right now, read without a lock.
   * The install start uses it to refuse before any request leaves; the
   * transactions that follow decide again under their own locks.
   */
  readSourceSlot(orgId: string): Promise<WooCommerceSourceSlot> {
    return this.readSlot(this.db, orgId);
  }

  /** In a transaction: read after the caller locked the organization. */
  private async readSlot(
    executor: Database | Transaction,
    orgId: string,
    options: { lock: boolean } = { lock: false },
  ): Promise<WooCommerceSourceSlot> {
    const sources = await executor
      .select({
        id: integrations.id,
        platformType: integrations.platformType,
        isActive: integrations.isActive,
      })
      .from(integrations)
      .where(eq(integrations.orgId, orgId))
      .limit(2);
    if (sources.length === 0) return { kind: 'fresh' };
    const [source] = sources;
    if (
      sources.length > 1 ||
      source.platformType !== 'woocommerce' ||
      source.isActive === true
    )
      return { kind: 'taken' };

    const query = executor
      .select()
      .from(woocommerceConnections)
      .where(
        and(
          eq(woocommerceConnections.integrationId, source.id),
          eq(woocommerceConnections.orgId, orgId),
        ),
      );
    const [connection] = await (options.lock ? query.for('update') : query);
    // A WooCommerce source that is inactive without a recorded disconnect was
    // switched off by something else; it is not the merchant's to reconnect.
    return connection?.disconnectedAt
      ? { kind: 'reconnect', connection }
      : { kind: 'taken' };
  }

  /**
   * The local half of a disconnect (US-07-05), in one transaction: the source
   * stops being active, which every queued effect already checks, and every
   * credential, the delivery token hash and the webhook ids are wiped. The
   * store URL stays for a same-store reconnect, and the integration, its
   * orders and its history are not touched.
   *
   * The row is returned as it was under the lock, so the caller can still
   * ask the store to delete Akeed's webhooks; nothing of it is at rest any
   * more by then.
   *
   * Open install contexts are retired first, in the order `connect` locks
   * (context, then organization), so a link opened before the disconnect
   * cannot reconnect behind it.
   */
  async disconnect(
    orgId: string,
    userId: string,
    now = new Date(),
  ): Promise<DisconnectWooCommerceResult> {
    const timestamp = now.toISOString();
    return withSerializableRetry(() =>
      this.db.transaction(async (tx) => {
        await tx
          .update(woocommercePendingInstalls)
          .set({ supersededAt: timestamp })
          .where(
            and(
              eq(woocommercePendingInstalls.orgId, orgId),
              isNull(woocommercePendingInstalls.consumedAt),
              isNull(woocommercePendingInstalls.supersededAt),
            ),
          );
        await tx
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.id, orgId))
          .for('update');
        const [connection] = await tx
          .select()
          .from(woocommerceConnections)
          .where(eq(woocommerceConnections.orgId, orgId))
          .for('update');
        if (!connection) return { kind: 'not_connected' as const };
        const { integrationId } = connection;
        if (connection.disconnectedAt)
          return { kind: 'already_disconnected' as const, integrationId };

        await tx
          .update(integrations)
          .set({ isActive: false, updatedAt: timestamp })
          .where(
            and(
              eq(integrations.id, integrationId),
              eq(integrations.orgId, orgId),
              eq(integrations.platformType, 'woocommerce'),
            ),
          );
        await tx
          .update(woocommerceConnections)
          .set({
            consumerKeyEncrypted: null,
            consumerSecretEncrypted: null,
            webhookSecretEncrypted: null,
            webhookTokenHash: null,
            orderCreatedWebhookId: null,
            orderUpdatedWebhookId: null,
            orderCreatedWebhookState: null,
            orderUpdatedWebhookState: null,
            storeVerifiedAt: null,
            disconnectedAt: timestamp,
            disconnectedBy: userId,
            updatedAt: timestamp,
          })
          .where(
            and(
              eq(woocommerceConnections.integrationId, integrationId),
              eq(woocommerceConnections.orgId, orgId),
            ),
          );
        return {
          kind: 'disconnected' as const,
          integrationId,
          previous: connection,
        };
      }),
    );
  }

  /**
   * What the store just answered for each webhook. Only a definite state is
   * stored: an answer that could not be read leaves the last one in place.
   * A connection disconnected meanwhile is not written to.
   */
  async recordWebhookStates(
    integrationId: string,
    orgId: string,
    states: {
      orderCreated?: WooCommerceWebhookStoredState;
      orderUpdated?: WooCommerceWebhookStoredState;
    },
    checkedAt: string,
  ): Promise<void> {
    if (!states.orderCreated && !states.orderUpdated) return;
    await this.db
      .update(woocommerceConnections)
      .set({
        ...(states.orderCreated
          ? { orderCreatedWebhookState: states.orderCreated }
          : {}),
        ...(states.orderUpdated
          ? { orderUpdatedWebhookState: states.orderUpdated }
          : {}),
        webhooksCheckedAt: checkedAt,
        updatedAt: checkedAt,
      })
      .where(
        and(
          eq(woocommerceConnections.integrationId, integrationId),
          eq(woocommerceConnections.orgId, orgId),
          isNull(woocommerceConnections.disconnectedAt),
        ),
      );
  }

  /** The organization's one connection, connected or disconnected. */
  async findByOrganization(
    orgId: string,
  ): Promise<WooCommerceConnection | undefined> {
    const [connection] = await this.db
      .select()
      .from(woocommerceConnections)
      .where(eq(woocommerceConnections.orgId, orgId))
      .limit(1);
    return connection;
  }

  async getOverview(orgId: string): Promise<WooCommerceConnectionOverview> {
    const [organizationRows, sources, connections, pendings] =
      await Promise.all([
        this.db
          .select({ name: organizations.name })
          .from(organizations)
          .where(eq(organizations.id, orgId))
          .limit(1),
        this.db
          .select({ platformType: integrations.platformType })
          .from(integrations)
          .where(eq(integrations.orgId, orgId)),
        this.db
          .select()
          .from(woocommerceConnections)
          .where(eq(woocommerceConnections.orgId, orgId))
          .limit(1),
        this.db
          .select()
          .from(woocommercePendingInstalls)
          .where(eq(woocommercePendingInstalls.orgId, orgId))
          .orderBy(desc(woocommercePendingInstalls.createdAt))
          .limit(1),
      ]);
    return {
      organizationName: organizationRows[0]?.name ?? null,
      sourcePlatforms: sources.map((source) => source.platformType),
      connection: connections[0],
      latestPending: pendings[0],
    };
  }

  /**
   * The connection a delivery URL token belongs to. Not scoped by
   * organization: the delivery is unauthenticated and the token's hash is the
   * tenant signal, so one token resolves to one connection or to nothing.
   */
  async findByWebhookTokenHash(
    webhookTokenHash: string,
  ): Promise<WooCommerceConnection | undefined> {
    const [connection] = await this.db
      .select()
      .from(woocommerceConnections)
      .where(eq(woocommerceConnections.webhookTokenHash, webhookTokenHash))
      .limit(1);
    return connection;
  }

  async findByIntegration(
    integrationId: string,
    orgId: string,
  ): Promise<WooCommerceConnection | undefined> {
    const [connection] = await this.db
      .select()
      .from(woocommerceConnections)
      .where(
        and(
          eq(woocommerceConnections.integrationId, integrationId),
          eq(woocommerceConnections.orgId, orgId),
        ),
      )
      .limit(1);
    return connection;
  }

  /** What the store's last answer to an authenticated call said of the keys. */
  async setHealth(
    integrationId: string,
    orgId: string,
    health: WooCommerceConnectionHealthState,
  ): Promise<void> {
    await this.db
      .update(woocommerceConnections)
      .set({ health, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(woocommerceConnections.integrationId, integrationId),
          eq(woocommerceConnections.orgId, orgId),
          ne(woocommerceConnections.health, health),
        ),
      );
  }

  /**
   * A delivery that reached a valid URL token and failed the signature or the
   * source check.
   */
  async recordRejectedDelivery(
    integrationId: string,
    orgId: string,
  ): Promise<void> {
    await this.db
      .update(woocommerceConnections)
      .set({
        rejectedDeliveries: sql`${woocommerceConnections.rejectedDeliveries} + 1`,
        lastRejectedAt: sql`now()`,
      })
      .where(
        and(
          eq(woocommerceConnections.integrationId, integrationId),
          eq(woocommerceConnections.orgId, orgId),
        ),
      );
  }

  /**
   * Whether a delivery URL token is one Akeed issued and still honours: the
   * token of a connection, or of an install that can still connect. The
   * second matters because the store pings the URL while the callback is
   * still creating the webhooks, before any connection row exists.
   */
  async isKnownWebhookToken(
    webhookTokenHash: string,
    now = new Date(),
  ): Promise<boolean> {
    const [[connection], [pending]] = await Promise.all([
      this.db
        .select({ integrationId: woocommerceConnections.integrationId })
        .from(woocommerceConnections)
        .where(eq(woocommerceConnections.webhookTokenHash, webhookTokenHash))
        .limit(1),
      this.db
        .select()
        .from(woocommercePendingInstalls)
        .where(
          eq(woocommercePendingInstalls.webhookTokenHash, webhookTokenHash),
        )
        .limit(1),
    ]);
    return (
      Boolean(connection) ||
      (pending !== undefined && isUsablePendingInstall(pending, now))
    );
  }
}
