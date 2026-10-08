import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../index';
import { DRIZZLE } from '../database.provider';
import {
  easyordersConnections,
  easyordersPendingInstalls,
  integrations,
  organizations,
} from '../schema';
import {
  databaseErrorCode,
  withSerializableRetry,
} from '../../../shared/database/serializable-retry';
import {
  provisionSourceBilling,
  readSourceBillingOptions,
  STANDALONE_SOURCE_DEFAULTS,
} from './standalone-organization-provisioning.repository';

type Database = PostgresJsDatabase<typeof schema>;

export type EasyOrdersPendingInstall =
  typeof easyordersPendingInstalls.$inferSelect;
export type EasyOrdersConnection = typeof easyordersConnections.$inferSelect;

/** A context that failed this many callbacks is dead; the seller starts again. */
export const EASYORDERS_MAX_CALLBACK_ATTEMPTS = 5;

/** Longest store name the WhatsApp template variable takes. */
const STORE_NAME_MAX_LENGTH = 60;

export function buildEasyOrdersSourceIdentity(orgId: string): string {
  return `easyorders:${orgId}`;
}

/**
 * Whether a context can still be consumed: unused, not replaced by a newer
 * one, not expired and not exhausted.
 */
export function isUsablePendingInstall(
  pending: Pick<
    EasyOrdersPendingInstall,
    'consumedAt' | 'supersededAt' | 'expiresAt' | 'attempts'
  >,
  now: Date,
): boolean {
  return (
    pending.consumedAt === null &&
    pending.supersededAt === null &&
    pending.attempts < EASYORDERS_MAX_CALLBACK_ATTEMPTS &&
    new Date(pending.expiresAt).getTime() > now.getTime()
  );
}

export interface NewEasyOrdersPendingInstall {
  orgId: string;
  createdBy: string;
  callbackTokenHash: string;
  webhookTokenHash: string;
  webhookTokenHint: string;
  /** Ciphertext from `encryptToken`, kept for the cleanup at disconnect. */
  webhookTokenEncrypted: string;
  expiresAt: string;
}

export type CreatePendingInstallResult =
  | { kind: 'created'; pending: EasyOrdersPendingInstall }
  | { kind: 'source_exists' };

export interface ConnectEasyOrdersInput {
  pendingInstallId: string;
  storeId: string;
  /** Ciphertext from `encryptToken`; the repository never sees the key. */
  apiKeyEncrypted: string;
  health: 'ok' | 'store_inactive';
}

export type ConnectEasyOrdersResult =
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

export type DisconnectEasyOrdersResult =
  | {
      kind: 'disconnected';
      integrationId: string;
      storeWasVerified: boolean;
      /**
       * The ciphertexts the transaction wiped, as read under its lock: what
       * the caller needs to remove the webhooks at EasyOrders. The token is
       * null on a row connected before it was kept.
       */
      apiKeyEncrypted: string | null;
      webhookTokenEncrypted: string | null;
    }
  | { kind: 'already_disconnected'; integrationId: string }
  | { kind: 'not_connected' };

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * What an organization's sources allow: a first connect, a reconnect of its
 * own disconnected EasyOrders source, or nothing. Any other source, active or
 * not, is `taken`: there is no source switching.
 */
type EasyOrdersSourceSlot =
  | { kind: 'fresh' }
  | { kind: 'reconnect'; connection: EasyOrdersConnection }
  | { kind: 'taken' };

/** Whether EasyOrders still holds the webhooks of a disconnected source. */
export type EasyOrdersProviderCleanup = 'removed' | 'manual';

export type EasyOrdersWebhookSecretKind = 'orders' | 'status';

export type EasyOrdersConnectionHealthState =
  | 'ok'
  | 'store_inactive'
  | 'credentials_rejected';

/** What a webhook URL token resolves to: one connection and its source. */
export interface EasyOrdersWebhookSource {
  connection: EasyOrdersConnection;
  sourceActive: boolean;
}

export interface EasyOrdersConnectionOverview {
  organizationName: string | null;
  /** Platform types of every source the organization has, active or not. */
  sourcePlatforms: string[];
  connection: EasyOrdersConnection | undefined;
  latestPending: EasyOrdersPendingInstall | undefined;
}

@Injectable()
export class EasyOrdersConnectionsRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly config: ConfigService,
  ) {}

  /**
   * Opens an install context for a source-less organization, or for one whose
   * only source is its own disconnected EasyOrders one, and retires its
   * earlier open ones, so at most one context per organization can connect.
   * The organization row is locked, so a callback finishing at the same time
   * is seen either before or after, never half-way.
   *
   * It takes the organization and then the open contexts, the reverse of
   * `connect`, so a callback in flight can deadlock with it. Nothing was
   * committed by the aborted side, so the whole transaction is run again.
   */
  async createPendingInstall(
    input: NewEasyOrdersPendingInstall,
  ): Promise<CreatePendingInstallResult> {
    return withSerializableRetry(() =>
      this.db.transaction(async (tx) => {
        await tx
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.id, input.orgId))
          .for('update');
        const slot = await this.readSourceSlot(tx, input.orgId);
        if (slot.kind === 'taken') return { kind: 'source_exists' as const };

        await tx
          .update(easyordersPendingInstalls)
          .set({ supersededAt: sql`now()` })
          .where(
            and(
              eq(easyordersPendingInstalls.orgId, input.orgId),
              isNull(easyordersPendingInstalls.consumedAt),
              isNull(easyordersPendingInstalls.supersededAt),
            ),
          );
        const [pending] = await tx
          .insert(easyordersPendingInstalls)
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
  ): Promise<EasyOrdersPendingInstall | undefined> {
    const [pending] = await this.db
      .select()
      .from(easyordersPendingInstalls)
      .where(eq(easyordersPendingInstalls.callbackTokenHash, callbackTokenHash))
      .limit(1);
    return pending;
  }

  async recordFailedAttempt(
    pendingInstallId: string,
    errorCode: string,
  ): Promise<void> {
    await this.db
      .update(easyordersPendingInstalls)
      .set({
        attempts: sql`${easyordersPendingInstalls.attempts} + 1`,
        lastErrorCode: errorCode,
      })
      .where(eq(easyordersPendingInstalls.id, pendingInstallId));
  }

  /** A verified store belongs to one integration; a claim blocks nobody. */
  async isStoreVerifiedForAnotherOrganization(
    storeId: string,
    orgId: string,
  ): Promise<boolean> {
    const [taken] = await this.db
      .select({ integrationId: easyordersConnections.integrationId })
      .from(easyordersConnections)
      .where(
        and(
          eq(easyordersConnections.storeId, storeId),
          isNotNull(easyordersConnections.storeVerifiedAt),
          ne(easyordersConnections.orgId, orgId),
        ),
      )
      .limit(1);
    return Boolean(taken);
  }

  /**
   * Consumes the context and provisions the source in one transaction: the
   * `easyorders` integration with the onboarding defaults, its credentials
   * and the organization's credit account with the launch grant. Either all of it is stored or none.
   *
   * A disconnected source is brought back in place instead (US-06-05): the
   * same integration row, so its orders and history stay attached, with a new
   * key and URL token and no webhook secrets (they are learned again). The store must be the one that
   * was connected, and its claim is unverified again because the new key has
   * proven nothing yet.
   *
   * Locks the context first, then the organization, so two callbacks on one
   * link and two links for one organization both serialize; the loser sees a
   * consumed context or an existing source and changes nothing. The partial
   * unique index on active sources is the backstop.
   */
  async connect(
    input: ConnectEasyOrdersInput,
    now = new Date(),
  ): Promise<ConnectEasyOrdersResult> {
    try {
      return await withSerializableRetry(() =>
        this.db.transaction((tx) => this.connectInTransaction(tx, input, now)),
      );
    } catch (error) {
      if (databaseErrorCode(error) !== '23505') throw error;
      const [pending] = await this.db
        .select({ orgId: easyordersPendingInstalls.orgId })
        .from(easyordersPendingInstalls)
        .where(eq(easyordersPendingInstalls.id, input.pendingInstallId))
        .limit(1);
      return pending
        ? { kind: 'source_exists', orgId: pending.orgId }
        : { kind: 'context_invalid' };
    }
  }

  private async connectInTransaction(
    tx: Transaction,
    input: ConnectEasyOrdersInput,
    now: Date,
  ): Promise<ConnectEasyOrdersResult> {
    const [pending] = await tx
      .select()
      .from(easyordersPendingInstalls)
      .where(eq(easyordersPendingInstalls.id, input.pendingInstallId))
      .for('update');
    if (!pending || !isUsablePendingInstall(pending, now))
      return { kind: 'context_invalid' };
    const { orgId } = pending;

    const [organization] = await tx
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .for('update');
    if (!organization) return { kind: 'context_invalid' };

    const slot = await this.readSourceSlot(tx, orgId, { lock: true });
    if (slot.kind === 'taken') return { kind: 'source_exists', orgId };
    if (slot.kind === 'reconnect' && slot.connection.storeId !== input.storeId)
      return { kind: 'store_mismatch', orgId };

    const [verifiedElsewhere] = await tx
      .select({ integrationId: easyordersConnections.integrationId })
      .from(easyordersConnections)
      .where(
        and(
          eq(easyordersConnections.storeId, input.storeId),
          isNotNull(easyordersConnections.storeVerifiedAt),
        ),
      )
      .limit(1);
    if (verifiedElsewhere) return { kind: 'store_unavailable', orgId };

    const timestamp = now.toISOString();
    // Before the reconnect branch: a source disconnected before credit billing
    // reached this platform gets its account too, and never a second grant.
    const billing = await provisionSourceBilling(
      tx,
      orgId,
      readSourceBillingOptions(this.config, pending.createdBy),
      timestamp,
    );
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
        .update(easyordersConnections)
        .set({
          storeVerifiedAt: null,
          apiKeyEncrypted: input.apiKeyEncrypted,
          webhookTokenHash: pending.webhookTokenHash,
          webhookTokenHint: pending.webhookTokenHint,
          webhookTokenEncrypted: pending.webhookTokenEncrypted,
          ordersWebhookSecretEncrypted: null,
          statusWebhookSecretEncrypted: null,
          disconnectedAt: null,
          disconnectedBy: null,
          providerCleanup: null,
          health: input.health,
          rejectedDeliveries: 0,
          lastRejectedAt: null,
          connectedBy: pending.createdBy,
          updatedAt: timestamp,
        })
        .where(
          and(
            eq(easyordersConnections.integrationId, integrationId),
            eq(easyordersConnections.orgId, orgId),
          ),
        );
      await tx
        .update(easyordersPendingInstalls)
        .set({ consumedAt: timestamp, lastErrorCode: null })
        .where(eq(easyordersPendingInstalls.id, pending.id));
      return { kind: 'connected', orgId, integrationId, reconnected: true };
    }

    const [integration] = await tx
      .insert(integrations)
      .values({
        orgId,
        platformType: 'easyorders',
        // The source identity is the organization, not the store: it stays
        // stable across key rotation, and an unverified store claim cannot
        // occupy the platform/store uniqueness slot.
        platformStoreUrl: buildEasyOrdersSourceIdentity(orgId),
        accessToken: null,
        webhookSecret: null,
        isActive: true,
        ...STANDALONE_SOURCE_DEFAULTS,
        // EasyOrders states the payment method; a missing one is unknown,
        // not cash on delivery (contract record section 4).
        assumeCodWhenPaymentMissing: false,
        storeName:
          organization.name.trim().slice(0, STORE_NAME_MAX_LENGTH).trim() ||
          null,
        onboardingStatus: 'pending',
        // Billed like Standalone: prepaid credits, or the Starter plan while
        // credit billing is switched off.
        ...billing,
      })
      .returning({ id: integrations.id });

    await tx.insert(easyordersConnections).values({
      integrationId: integration.id,
      orgId,
      storeId: input.storeId,
      storeVerifiedAt: null,
      apiKeyEncrypted: input.apiKeyEncrypted,
      webhookTokenHash: pending.webhookTokenHash,
      webhookTokenHint: pending.webhookTokenHint,
      webhookTokenEncrypted: pending.webhookTokenEncrypted,
      health: input.health,
      connectedBy: pending.createdBy,
    });

    await tx
      .update(easyordersPendingInstalls)
      .set({ consumedAt: timestamp, lastErrorCode: null })
      .where(eq(easyordersPendingInstalls.id, pending.id));

    return {
      kind: 'connected',
      orgId,
      integrationId: integration.id,
      reconnected: false,
    };
  }

  /** Reads inside the caller's transaction, after it locked the organization. */
  private async readSourceSlot(
    tx: Transaction,
    orgId: string,
    options: { lock: boolean } = { lock: false },
  ): Promise<EasyOrdersSourceSlot> {
    const sources = await tx
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
      source.platformType !== 'easyorders' ||
      source.isActive === true
    )
      return { kind: 'taken' };

    const query = tx
      .select()
      .from(easyordersConnections)
      .where(
        and(
          eq(easyordersConnections.integrationId, source.id),
          eq(easyordersConnections.orgId, orgId),
        ),
      );
    const [connection] = await (options.lock ? query.for('update') : query);
    // An EasyOrders source that is inactive without a recorded disconnect was
    // switched off by something else; it is not the merchant's to reconnect.
    return connection?.disconnectedAt
      ? { kind: 'reconnect', connection }
      : { kind: 'taken' };
  }

  /**
   * The local half of a disconnect (US-06-05), in one transaction: the source
   * stops being active, which every queued effect already checks, and every
   * credential is wiped. The store id stays for a same-store reconnect, and
   * the integration, its orders and its history are not touched.
   *
   * Open install contexts are retired first, in the order `connect` locks
   * (context, then organization), so a link opened before the disconnect
   * cannot reconnect behind it.
   */
  async disconnect(
    orgId: string,
    userId: string,
    now = new Date(),
  ): Promise<DisconnectEasyOrdersResult> {
    const timestamp = now.toISOString();
    return withSerializableRetry(() =>
      this.db.transaction(async (tx) => {
        await tx
          .update(easyordersPendingInstalls)
          .set({ supersededAt: timestamp })
          .where(
            and(
              eq(easyordersPendingInstalls.orgId, orgId),
              isNull(easyordersPendingInstalls.consumedAt),
              isNull(easyordersPendingInstalls.supersededAt),
            ),
          );
        await tx
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.id, orgId))
          .for('update');
        const [connection] = await tx
          .select()
          .from(easyordersConnections)
          .where(eq(easyordersConnections.orgId, orgId))
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
              eq(integrations.platformType, 'easyorders'),
            ),
          );
        await tx
          .update(easyordersConnections)
          .set({
            apiKeyEncrypted: null,
            webhookTokenHash: null,
            webhookTokenHint: null,
            webhookTokenEncrypted: null,
            ordersWebhookSecretEncrypted: null,
            statusWebhookSecretEncrypted: null,
            storeVerifiedAt: null,
            disconnectedAt: timestamp,
            disconnectedBy: userId,
            updatedAt: timestamp,
          })
          .where(
            and(
              eq(easyordersConnections.integrationId, integrationId),
              eq(easyordersConnections.orgId, orgId),
            ),
          );
        return {
          kind: 'disconnected' as const,
          integrationId,
          storeWasVerified: connection.storeVerifiedAt !== null,
          apiKeyEncrypted: connection.apiKeyEncrypted,
          webhookTokenEncrypted: connection.webhookTokenEncrypted,
        };
      }),
    );
  }

  async getOverview(orgId: string): Promise<EasyOrdersConnectionOverview> {
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
          .from(easyordersConnections)
          .where(eq(easyordersConnections.orgId, orgId))
          .limit(1),
        this.db
          .select()
          .from(easyordersPendingInstalls)
          .where(eq(easyordersPendingInstalls.orgId, orgId))
          .orderBy(desc(easyordersPendingInstalls.createdAt))
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
   * The only tenant resolver for webhooks: they are unauthenticated and the
   * URL token's hash is what binds a delivery to one integration. A rotated
   * or unknown token resolves to nothing.
   */
  async findByWebhookTokenHash(
    webhookTokenHash: string,
  ): Promise<EasyOrdersWebhookSource | undefined> {
    const [row] = await this.db
      .select({
        connection: easyordersConnections,
        isActive: integrations.isActive,
      })
      .from(easyordersConnections)
      .innerJoin(
        integrations,
        and(
          eq(integrations.id, easyordersConnections.integrationId),
          eq(integrations.orgId, easyordersConnections.orgId),
        ),
      )
      .where(eq(easyordersConnections.webhookTokenHash, webhookTokenHash))
      .limit(1);
    return row
      ? { connection: row.connection, sourceActive: row.isActive === true }
      : undefined;
  }

  async findByIntegration(
    integrationId: string,
    orgId: string,
  ): Promise<EasyOrdersConnection | undefined> {
    const [connection] = await this.db
      .select()
      .from(easyordersConnections)
      .where(
        and(
          eq(easyordersConnections.integrationId, integrationId),
          eq(easyordersConnections.orgId, orgId),
        ),
      )
      .limit(1);
    return connection;
  }

  /** A delivery that reached a valid URL token with a wrong secret. */
  async recordRejectedDelivery(
    integrationId: string,
    orgId: string,
  ): Promise<void> {
    await this.db
      .update(easyordersConnections)
      .set({
        rejectedDeliveries: sql`${easyordersConnections.rejectedDeliveries} + 1`,
        lastRejectedAt: sql`now()`,
      })
      .where(
        and(
          eq(easyordersConnections.integrationId, integrationId),
          eq(easyordersConnections.orgId, orgId),
        ),
      );
  }

  async setHealth(
    integrationId: string,
    orgId: string,
    health: EasyOrdersConnectionHealthState,
  ): Promise<void> {
    await this.db
      .update(easyordersConnections)
      .set({ health, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(easyordersConnections.integrationId, integrationId),
          eq(easyordersConnections.orgId, orgId),
          ne(easyordersConnections.health, health),
        ),
      );
  }

  /**
   * Turns the store claim into a verified one, once data fetched with the
   * stored key carried the same store id. `taken` means another integration
   * already holds the store's one verified slot.
   */
  async markStoreVerified(
    integrationId: string,
    orgId: string,
    storeId: string,
  ): Promise<'verified' | 'taken'> {
    try {
      await this.db
        .update(easyordersConnections)
        .set({
          storeVerifiedAt: sql`now()`,
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(easyordersConnections.integrationId, integrationId),
            eq(easyordersConnections.orgId, orgId),
            eq(easyordersConnections.storeId, storeId),
            isNull(easyordersConnections.storeVerifiedAt),
            isNull(easyordersConnections.disconnectedAt),
          ),
        );
      return 'verified';
    } catch (error) {
      if (databaseErrorCode(error) === '23505') return 'taken';
      throw error;
    }
  }

  /** Answers whether the organization has a live connection to update. */
  async saveOrderSettings(
    orgId: string,
    settings: { currency: string; phoneCountry: string },
  ): Promise<boolean> {
    const updated = await this.db
      .update(easyordersConnections)
      .set({ ...settings, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(easyordersConnections.orgId, orgId),
          isNull(easyordersConnections.disconnectedAt),
        ),
      )
      .returning({ integrationId: easyordersConnections.integrationId });
    return updated.length > 0;
  }

  /**
   * How the webhook removal at EasyOrders went, on the row a disconnect just
   * closed. A reconnect that got in first leaves nothing to record.
   */
  async recordProviderCleanup(
    integrationId: string,
    orgId: string,
    providerCleanup: EasyOrdersProviderCleanup,
  ): Promise<void> {
    await this.db
      .update(easyordersConnections)
      .set({ providerCleanup })
      .where(
        and(
          eq(easyordersConnections.integrationId, integrationId),
          eq(easyordersConnections.orgId, orgId),
          isNotNull(easyordersConnections.disconnectedAt),
        ),
      );
  }

  /**
   * Keeps the secret a verified delivery carried, unless one is already
   * held: the first writer wins, and a later delivery is compared with it.
   */
  async learnWebhookSecret(
    integrationId: string,
    orgId: string,
    kind: EasyOrdersWebhookSecretKind,
    secretEncrypted: string,
  ): Promise<boolean> {
    const column =
      kind === 'orders'
        ? easyordersConnections.ordersWebhookSecretEncrypted
        : easyordersConnections.statusWebhookSecretEncrypted;
    const updated = await this.db
      .update(easyordersConnections)
      .set({
        ...(kind === 'orders'
          ? { ordersWebhookSecretEncrypted: secretEncrypted }
          : { statusWebhookSecretEncrypted: secretEncrypted }),
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(easyordersConnections.integrationId, integrationId),
          eq(easyordersConnections.orgId, orgId),
          isNull(column),
          isNull(easyordersConnections.disconnectedAt),
        ),
      )
      .returning({ integrationId: easyordersConnections.integrationId });
    return updated.length > 0;
  }

  /**
   * Forgets both secrets so they are learned again, and the rejections
   * counted against the old ones. Answers whether there is a live connection.
   */
  async clearWebhookSecrets(orgId: string): Promise<boolean> {
    const updated = await this.db
      .update(easyordersConnections)
      .set({
        ordersWebhookSecretEncrypted: null,
        statusWebhookSecretEncrypted: null,
        rejectedDeliveries: 0,
        lastRejectedAt: null,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(easyordersConnections.orgId, orgId),
          isNull(easyordersConnections.disconnectedAt),
        ),
      )
      .returning({ integrationId: easyordersConnections.integrationId });
    return updated.length > 0;
  }

  /** Write-only: answers whether the organization has a live connection to update. */
  async saveWebhookSecrets(
    orgId: string,
    secrets: {
      ordersWebhookSecretEncrypted: string;
      statusWebhookSecretEncrypted: string;
    },
  ): Promise<boolean> {
    const updated = await this.db
      .update(easyordersConnections)
      .set({ ...secrets, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(easyordersConnections.orgId, orgId),
          isNull(easyordersConnections.disconnectedAt),
        ),
      )
      .returning({ integrationId: easyordersConnections.integrationId });
    return updated.length > 0;
  }
}
