import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../index';
import { DRIZZLE } from '../database.provider';
import { integrationApiKeys } from '../schema';
import { isUniqueViolation } from './order-imports.repository';

type Database = PostgresJsDatabase<typeof schema>;

/** Everything about a key except its hash: what management code may see. */
export interface IntegrationApiKeyMetadata {
  id: string;
  orgId: string;
  integrationId: string;
  prefix: string;
  name: string;
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
}

/** What the API guard needs to authenticate a presented key. */
export interface IntegrationApiKeyCredential {
  id: string;
  orgId: string;
  integrationId: string;
  prefix: string;
  keyHash: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface NewIntegrationApiKey {
  orgId: string;
  integrationId: string;
  prefix: string;
  keyHash: string;
  name: string;
  createdBy: string;
}

export type CreateIntegrationApiKeyResult =
  | { kind: 'created'; key: IntegrationApiKeyMetadata }
  | { kind: 'limit_reached' };

export type RevokeIntegrationApiKeyResult =
  | { kind: 'revoked'; key: IntegrationApiKeyMetadata }
  | { kind: 'already_revoked'; key: IntegrationApiKeyMetadata }
  | { kind: 'not_found' };

/** Another key already holds the generated prefix; the caller draws again. */
export class IntegrationApiKeyPrefixTakenError extends Error {
  constructor() {
    super('Integration API key prefix is already taken');
    this.name = 'IntegrationApiKeyPrefixTakenError';
  }
}

/** The metadata columns; `key_hash` is deliberately absent. */
const METADATA_COLUMNS = {
  id: integrationApiKeys.id,
  orgId: integrationApiKeys.orgId,
  integrationId: integrationApiKeys.integrationId,
  prefix: integrationApiKeys.prefix,
  name: integrationApiKeys.name,
  createdBy: integrationApiKeys.createdBy,
  createdAt: integrationApiKeys.createdAt,
  lastUsedAt: integrationApiKeys.lastUsedAt,
  revokedAt: integrationApiKeys.revokedAt,
  revokedBy: integrationApiKeys.revokedBy,
};

@Injectable()
export class IntegrationApiKeysRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** Active keys first, then newest first. */
  async listByOrg(
    orgId: string,
    limit: number,
  ): Promise<IntegrationApiKeyMetadata[]> {
    return this.db
      .select(METADATA_COLUMNS)
      .from(integrationApiKeys)
      .where(eq(integrationApiKeys.orgId, orgId))
      .orderBy(
        sql`${integrationApiKeys.revokedAt} IS NOT NULL`,
        desc(integrationApiKeys.createdAt),
        desc(integrationApiKeys.id),
      )
      .limit(limit);
  }

  /**
   * Inserts a key unless the integration already has `maxActive` active keys.
   *
   * A per-integration advisory lock serializes concurrent creates, so two
   * requests that both counted four keys cannot both add a fifth and sixth.
   */
  async createWithinCap(
    key: NewIntegrationApiKey,
    maxActive: number,
  ): Promise<CreateIntegrationApiKeyResult> {
    try {
      return await this.db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`integration-api-keys:${key.integrationId}`}, 0))`,
        );
        const [{ active }] = await tx
          .select({ active: count() })
          .from(integrationApiKeys)
          .where(
            and(
              eq(integrationApiKeys.integrationId, key.integrationId),
              isNull(integrationApiKeys.revokedAt),
            ),
          );
        if (active >= maxActive) return { kind: 'limit_reached' };
        const [created] = await tx
          .insert(integrationApiKeys)
          .values(key)
          .returning(METADATA_COLUMNS);
        return { kind: 'created', key: created };
      });
    } catch (error) {
      if (isUniqueViolation(error))
        throw new IntegrationApiKeyPrefixTakenError();
      throw error;
    }
  }

  /**
   * Revokes at once. A key that is already revoked keeps its original
   * revocation time and actor, so repeating the call changes nothing.
   */
  async revoke(
    orgId: string,
    id: string,
    revokedBy: string,
  ): Promise<RevokeIntegrationApiKeyResult> {
    const [revoked] = await this.db
      .update(integrationApiKeys)
      .set({ revokedAt: sql`now()`, revokedBy })
      .where(
        and(
          eq(integrationApiKeys.id, id),
          eq(integrationApiKeys.orgId, orgId),
          isNull(integrationApiKeys.revokedAt),
        ),
      )
      .returning(METADATA_COLUMNS);
    if (revoked) return { kind: 'revoked', key: revoked };
    const [existing] = await this.db
      .select(METADATA_COLUMNS)
      .from(integrationApiKeys)
      .where(
        and(eq(integrationApiKeys.id, id), eq(integrationApiKeys.orgId, orgId)),
      )
      .limit(1);
    return existing
      ? { kind: 'already_revoked', key: existing }
      : { kind: 'not_found' };
  }

  /**
   * The one lookup not scoped by organization: the presented key is itself
   * the proof of tenancy, and the row it finds says which organization and
   * integration it belongs to. Only `IntegrationApiKeyGuard` may call this.
   */
  async findByPrefixForAuthentication(
    prefix: string,
  ): Promise<IntegrationApiKeyCredential | null> {
    const [row] = await this.db
      .select({
        id: integrationApiKeys.id,
        orgId: integrationApiKeys.orgId,
        integrationId: integrationApiKeys.integrationId,
        prefix: integrationApiKeys.prefix,
        keyHash: integrationApiKeys.keyHash,
        lastUsedAt: integrationApiKeys.lastUsedAt,
        revokedAt: integrationApiKeys.revokedAt,
      })
      .from(integrationApiKeys)
      .where(eq(integrationApiKeys.prefix, prefix))
      .limit(1);
    return row ?? null;
  }

  /**
   * Records use at most once a minute. The condition lives in the statement,
   * so concurrent requests write once, and it only ever sets `last_used_at`:
   * it cannot undo a revocation that commits in between.
   */
  async touchLastUsed(id: string): Promise<void> {
    await this.db
      .update(integrationApiKeys)
      .set({ lastUsedAt: sql`now()` })
      .where(
        and(
          eq(integrationApiKeys.id, id),
          isNull(integrationApiKeys.revokedAt),
          sql`(${integrationApiKeys.lastUsedAt} IS NULL OR ${integrationApiKeys.lastUsedAt} < now() - interval '1 minute')`,
        ),
      );
  }
}
