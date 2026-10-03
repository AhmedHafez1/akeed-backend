import { Inject, Injectable } from '@nestjs/common';
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
  STANDALONE_BILLING_STATUS,
  STANDALONE_DEFAULT_PLAN_ID,
} from '../../../shared/billing/billing-plan';
import {
  databaseErrorCode,
  withSerializableRetry,
} from '../../../shared/database/serializable-retry';
import { STANDALONE_SOURCE_DEFAULTS } from './standalone-organization-provisioning.repository';

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
  | { kind: 'connected'; orgId: string; integrationId: string }
  | { kind: 'context_invalid' }
  | { kind: 'source_exists'; orgId: string }
  | { kind: 'store_unavailable'; orgId: string };

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
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Opens an install context for a source-less organization and retires its
   * earlier open ones, so at most one context per organization can connect.
   * The organization row is locked, so a callback finishing at the same time
   * is seen either before or after, never half-way.
   */
  async createPendingInstall(
    input: NewEasyOrdersPendingInstall,
  ): Promise<CreatePendingInstallResult> {
    return this.db.transaction(async (tx) => {
      await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, input.orgId))
        .for('update');
      const [existingSource] = await tx
        .select({ id: integrations.id })
        .from(integrations)
        .where(eq(integrations.orgId, input.orgId))
        .limit(1);
      if (existingSource) return { kind: 'source_exists' as const };

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
    });
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
   * `easyorders` integration with the pilot entitlement and the onboarding
   * defaults, and its credentials. Either all of it is stored or none.
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
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
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

    const [existingSource] = await tx
      .select({ id: integrations.id })
      .from(integrations)
      .where(eq(integrations.orgId, orgId))
      .limit(1);
    if (existingSource) return { kind: 'source_exists', orgId };

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
        // The existing pilot entitlement (US-03-02). Prepaid credits are a
        // Standalone-only accounting mode, so the plan columns govern here.
        billingStatus: STANDALONE_BILLING_STATUS,
        billingPlanId: STANDALONE_DEFAULT_PLAN_ID,
        billingActivatedAt: timestamp,
        billingStatusUpdatedAt: timestamp,
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
      health: input.health,
      connectedBy: pending.createdBy,
    });

    await tx
      .update(easyordersPendingInstalls)
      .set({ consumedAt: timestamp, lastErrorCode: null })
      .where(eq(easyordersPendingInstalls.id, pending.id));

    return { kind: 'connected', orgId, integrationId: integration.id };
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
          ),
        );
      return 'verified';
    } catch (error) {
      if (databaseErrorCode(error) === '23505') return 'taken';
      throw error;
    }
  }

  /** Answers whether the organization has a connection to update. */
  async saveOrderSettings(
    orgId: string,
    settings: { currency: string; phoneCountry: string },
  ): Promise<boolean> {
    const updated = await this.db
      .update(easyordersConnections)
      .set({ ...settings, updatedAt: new Date().toISOString() })
      .where(eq(easyordersConnections.orgId, orgId))
      .returning({ integrationId: easyordersConnections.integrationId });
    return updated.length > 0;
  }

  /** Write-only: answers whether the organization has a connection to update. */
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
      .where(eq(easyordersConnections.orgId, orgId))
      .returning({ integrationId: easyordersConnections.integrationId });
    return updated.length > 0;
  }
}
