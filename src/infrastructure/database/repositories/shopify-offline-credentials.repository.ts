import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database.provider';
import { integrations, shopifyOfflineCredentials } from '../schema';
import { encryptToken } from '../../../shared/utils/token-encryption.util';

type Transaction = Parameters<Parameters<DrizzleDB['transaction']>[0]>[0];
type Executor = DrizzleDB | Transaction;

export interface ExpiringTokenPairInput {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
}

/** How the stored pair came to be; each sets its own timestamp. */
export type CredentialWriteEvent = 'acquired' | 'refreshed' | 'migrated';

/**
 * One store's credential as stored: both tokens still encrypted. A store with
 * no credential row reads as `legacy` and `active`.
 */
export interface ShopifyCredentialState {
  integrationId: string;
  shopDomain: string;
  isActive: boolean;
  accessToken: string | null;
  credentialKind: 'legacy' | 'expiring';
  refreshToken: string | null;
  accessTokenExpiresAt: string | null;
  refreshTokenExpiresAt: string | null;
  status: 'active' | 'reauth_required';
  generation: number;
}

const STATE_COLUMNS = {
  integrationId: integrations.id,
  shopDomain: integrations.platformStoreUrl,
  isActive: integrations.isActive,
  accessToken: integrations.accessToken,
  credentialKind: shopifyOfflineCredentials.credentialKind,
  refreshToken: shopifyOfflineCredentials.refreshToken,
  accessTokenExpiresAt: shopifyOfflineCredentials.accessTokenExpiresAt,
  refreshTokenExpiresAt: shopifyOfflineCredentials.refreshTokenExpiresAt,
  status: shopifyOfflineCredentials.status,
  generation: shopifyOfflineCredentials.generation,
};

type StateRow = {
  [K in keyof typeof STATE_COLUMNS]:
    | (typeof STATE_COLUMNS)[K]['_']['data']
    | null;
};

function toState(row: StateRow): ShopifyCredentialState {
  return {
    integrationId: row.integrationId as string,
    shopDomain: row.shopDomain as string,
    isActive: row.isActive === true,
    accessToken: row.accessToken,
    credentialKind: row.credentialKind ?? 'legacy',
    refreshToken: row.refreshToken,
    accessTokenExpiresAt: row.accessTokenExpiresAt,
    refreshTokenExpiresAt: row.refreshTokenExpiresAt,
    status: row.status ?? 'active',
    generation: row.generation ?? 0,
  };
}

/**
 * Shopify offline credentials. Every acquisition, refresh and move from a
 * non-expiring token for one shop runs inside `withShopLock`: Shopify retires
 * a pair whenever another is issued, so two at once would leave the store
 * holding a dead refresh token.
 */
@Injectable()
export class ShopifyOfflineCredentialsRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(ConfigService) private readonly configService: ConfigService,
  ) {}

  /**
   * Runs `fn` in a transaction holding the shop's credential lock. The lock
   * is held across the Shopify call on purpose; that call is bounded by a
   * 10-second timeout.
   */
  withShopLock<T>(
    shopDomain: string,
    fn: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`shopify-offline-credential:${shopDomain}`}, 0))`,
      );
      return fn(tx);
    });
  }

  async findState(
    integrationId: string,
    executor: Executor = this.db,
  ): Promise<ShopifyCredentialState | undefined> {
    const [row] = await executor
      .select(STATE_COLUMNS)
      .from(integrations)
      .leftJoin(
        shopifyOfflineCredentials,
        eq(shopifyOfflineCredentials.integrationId, integrations.id),
      )
      .where(eq(integrations.id, integrationId))
      .limit(1);
    return row ? toState(row) : undefined;
  }

  async findStateByShop(
    shopDomain: string,
  ): Promise<ShopifyCredentialState | undefined> {
    const [row] = await this.db
      .select(STATE_COLUMNS)
      .from(integrations)
      .leftJoin(
        shopifyOfflineCredentials,
        eq(shopifyOfflineCredentials.integrationId, integrations.id),
      )
      .where(
        and(
          eq(integrations.platformType, 'shopify'),
          eq(integrations.platformStoreUrl, shopDomain),
        ),
      )
      .limit(1);
    return row ? toState(row) : undefined;
  }

  /** Stores the new pair on the integration and the credential row. */
  async saveExpiringPair(
    tx: Transaction,
    integrationId: string,
    pair: ExpiringTokenPairInput,
    event: CredentialWriteEvent,
  ): Promise<void> {
    const now = new Date().toISOString();
    await tx
      .update(integrations)
      .set({
        accessToken: this.encrypt(pair.accessToken),
        expiresAt: pair.accessTokenExpiresAt,
        updatedAt: now,
      })
      .where(eq(integrations.id, integrationId));
    await this.upsertExpiringCredential(tx, integrationId, pair, event);
  }

  /** The credential row only; the caller has written the access token. */
  async upsertExpiringCredential(
    tx: Transaction,
    integrationId: string,
    pair: ExpiringTokenPairInput,
    event: CredentialWriteEvent,
  ): Promise<void> {
    const now = new Date().toISOString();
    const values = {
      credentialKind: 'expiring' as const,
      refreshToken: this.encrypt(pair.refreshToken),
      accessTokenExpiresAt: pair.accessTokenExpiresAt,
      refreshTokenExpiresAt: pair.refreshTokenExpiresAt,
      status: 'active' as const,
      lastErrorCode: null,
      lastErrorAt: null,
      updatedAt: now,
      ...(event === 'refreshed' ? { lastRefreshedAt: now } : {}),
      ...(event === 'migrated' ? { migratedAt: now } : {}),
    };
    await tx
      .insert(shopifyOfflineCredentials)
      .values({ integrationId, ...values })
      .onConflictDoUpdate({
        target: shopifyOfflineCredentials.integrationId,
        set: {
          ...values,
          generation: sql`${shopifyOfflineCredentials.generation} + 1`,
        },
      });
  }

  /** The store must reopen Akeed; kept outside any rolled-back transaction. */
  async markReauthRequired(
    integrationId: string,
    errorCode: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .insert(shopifyOfflineCredentials)
      .values({
        integrationId,
        credentialKind: 'legacy',
        status: 'reauth_required',
        lastErrorCode: errorCode,
        lastErrorAt: now,
      })
      .onConflictDoUpdate({
        target: shopifyOfflineCredentials.integrationId,
        set: {
          status: 'reauth_required',
          lastErrorCode: errorCode,
          lastErrorAt: now,
          updatedAt: now,
          generation: sql`${shopifyOfflineCredentials.generation} + 1`,
        },
      });
  }

  /** Notes a failure that leaves the credential usable. */
  async recordError(integrationId: string, errorCode: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .insert(shopifyOfflineCredentials)
      .values({
        integrationId,
        credentialKind: 'legacy',
        lastErrorCode: errorCode,
        lastErrorAt: now,
      })
      .onConflictDoUpdate({
        target: shopifyOfflineCredentials.integrationId,
        set: { lastErrorCode: errorCode, lastErrorAt: now, updatedAt: now },
      });
  }

  /**
   * Installed stores still on a non-expiring token, never-tried first and
   * recently failed last, so one failing store cannot hold up the rest.
   */
  async findLegacyBatch(
    limit: number,
    shops?: readonly string[],
  ): Promise<Array<{ integrationId: string; shopDomain: string }>> {
    return this.db
      .select({
        integrationId: integrations.id,
        shopDomain: integrations.platformStoreUrl,
      })
      .from(integrations)
      .leftJoin(
        shopifyOfflineCredentials,
        eq(shopifyOfflineCredentials.integrationId, integrations.id),
      )
      .where(
        and(
          eq(integrations.platformType, 'shopify'),
          eq(integrations.isActive, true),
          isNull(integrations.uninstalledAt),
          isNotNull(integrations.accessToken),
          or(
            isNull(shopifyOfflineCredentials.integrationId),
            and(
              eq(shopifyOfflineCredentials.credentialKind, 'legacy'),
              eq(shopifyOfflineCredentials.status, 'active'),
            ),
          ),
          shops && shops.length > 0
            ? inArray(integrations.platformStoreUrl, [...shops])
            : undefined,
        ),
      )
      .orderBy(
        sql`${shopifyOfflineCredentials.lastErrorAt} ASC NULLS FIRST`,
        asc(integrations.createdAt),
      )
      .limit(limit);
  }

  /** Expiring credentials whose refresh token ends by `before`. */
  async findRefreshDue(
    before: string,
    limit: number,
  ): Promise<
    Array<{ integrationId: string; shopDomain: string; generation: number }>
  > {
    return this.db
      .select({
        integrationId: shopifyOfflineCredentials.integrationId,
        shopDomain: integrations.platformStoreUrl,
        generation: shopifyOfflineCredentials.generation,
      })
      .from(shopifyOfflineCredentials)
      .innerJoin(
        integrations,
        eq(integrations.id, shopifyOfflineCredentials.integrationId),
      )
      .where(
        and(
          eq(shopifyOfflineCredentials.credentialKind, 'expiring'),
          eq(shopifyOfflineCredentials.status, 'active'),
          lte(shopifyOfflineCredentials.refreshTokenExpiresAt, before),
          eq(integrations.isActive, true),
        ),
      )
      .orderBy(asc(shopifyOfflineCredentials.refreshTokenExpiresAt))
      .limit(limit);
  }

  private encrypt(token: string): string {
    return encryptToken(
      token,
      this.configService.getOrThrow<string>('SHOPIFY_TOKEN_ENCRYPTION_KEY'),
    );
  }
}
