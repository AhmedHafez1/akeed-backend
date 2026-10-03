import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../index';
import { DRIZZLE } from '../database.provider';
import { commerceOutcomeSyncs } from '../schema';
import type {
  CommerceOutcomeAction,
  CommerceOutcomeSyncState,
} from '../../../shared/commerce/commerce-outcome';

export type CommerceOutcomeSync = typeof commerceOutcomeSyncs.$inferSelect;

export interface CommerceOutcomeSyncTarget {
  orgId: string;
  integrationId: string;
  orderId: string;
  externalOrderId: string;
  correlationId: string;
  action: CommerceOutcomeAction;
}

export interface CommerceOutcomeSyncSettlement {
  state: CommerceOutcomeSyncState;
  errorCode: string | null;
  providerStatus: string | null;
  requiresAssistance: boolean;
  nextAttemptAt: string | null;
  /** Which counter this try spends: a full attempt or a provider-named wait. */
  spent: 'attempt' | 'deferral';
}

export interface CommerceOutcomeSyncSummary {
  failedCount: number;
  lastFailedAt: string | null;
  requiresAssistance: boolean;
  pendingCount: number;
}

/** Raw aggregates come back as driver text; the API speaks ISO 8601. */
function toIsoOrNull(value: string | Date | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

/**
 * Whether a store has an outcome yet, per order and action (US-06-04). Every
 * method is scoped by the organization the caller already trusts.
 */
@Injectable()
export class CommerceOutcomeSyncsRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  /**
   * Opens a try for an order and action, or reopens the row it already has.
   * The counters are kept: a repeat of the same outcome is the same work.
   */
  async begin(
    target: CommerceOutcomeSyncTarget,
    retryInBackground: boolean,
  ): Promise<CommerceOutcomeSync> {
    const now = new Date().toISOString();
    const [row] = await this.db
      .insert(commerceOutcomeSyncs)
      .values({ ...target, state: 'pending', retryInBackground })
      .onConflictDoUpdate({
        target: [
          commerceOutcomeSyncs.integrationId,
          commerceOutcomeSyncs.orderId,
          commerceOutcomeSyncs.action,
        ],
        set: {
          state: 'pending',
          correlationId: target.correlationId,
          retryInBackground,
          requiresAssistance: false,
          errorCode: null,
          nextAttemptAt: null,
          updatedAt: now,
        },
        setWhere: eq(commerceOutcomeSyncs.orgId, target.orgId),
      })
      .returning();
    return row;
  }

  /** Records an action the source cannot take. Nothing is ever retried. */
  async recordUnsupported(
    target: CommerceOutcomeSyncTarget,
    reason: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .insert(commerceOutcomeSyncs)
      .values({ ...target, state: 'unsupported', errorCode: reason })
      .onConflictDoUpdate({
        target: [
          commerceOutcomeSyncs.integrationId,
          commerceOutcomeSyncs.orderId,
          commerceOutcomeSyncs.action,
        ],
        set: {
          state: 'unsupported',
          correlationId: target.correlationId,
          errorCode: reason,
          requiresAssistance: false,
          nextAttemptAt: null,
          updatedAt: now,
        },
        setWhere: eq(commerceOutcomeSyncs.orgId, target.orgId),
      });
  }

  async settle(
    id: string,
    orgId: string,
    settlement: CommerceOutcomeSyncSettlement,
  ): Promise<CommerceOutcomeSync | undefined> {
    const { spent, ...values } = settlement;
    const [row] = await this.db
      .update(commerceOutcomeSyncs)
      .set({
        ...values,
        ...(spent === 'attempt'
          ? { attempts: sql`${commerceOutcomeSyncs.attempts} + 1` }
          : { deferrals: sql`${commerceOutcomeSyncs.deferrals} + 1` }),
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(commerceOutcomeSyncs.id, id),
          eq(commerceOutcomeSyncs.orgId, orgId),
        ),
      )
      .returning();
    return row;
  }

  /** Closes a row that is still waiting; a settled row is left as it is. */
  async failPending(
    id: string,
    orgId: string,
    errorCode: string,
  ): Promise<void> {
    await this.db
      .update(commerceOutcomeSyncs)
      .set({
        state: 'failed',
        errorCode,
        nextAttemptAt: null,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(commerceOutcomeSyncs.id, id),
          eq(commerceOutcomeSyncs.orgId, orgId),
          eq(commerceOutcomeSyncs.state, 'pending'),
        ),
      );
  }

  /**
   * Closes every row of one source that is still waiting, when the source
   * stops being able to write (a disconnect). Answers how many were closed.
   */
  async failPendingForIntegration(
    orgId: string,
    integrationId: string,
    errorCode: string,
  ): Promise<number> {
    const closed = await this.db
      .update(commerceOutcomeSyncs)
      .set({
        state: 'failed',
        errorCode,
        nextAttemptAt: null,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(commerceOutcomeSyncs.orgId, orgId),
          eq(commerceOutcomeSyncs.integrationId, integrationId),
          eq(commerceOutcomeSyncs.state, 'pending'),
        ),
      )
      .returning({ id: commerceOutcomeSyncs.id });
    return closed.length;
  }

  /**
   * One source's store updates for its health view: failures since `since`,
   * and what is still waiting now. An unsupported action is neither.
   */
  async summarizeForIntegration(
    orgId: string,
    integrationId: string,
    since: Date,
  ): Promise<CommerceOutcomeSyncSummary> {
    const sinceIso = since.toISOString();
    const [row] = await this.db
      .select({
        failedCount: sql<number>`count(*) FILTER (WHERE ${commerceOutcomeSyncs.state} = 'failed' AND ${commerceOutcomeSyncs.updatedAt} >= ${sinceIso})::int`,
        lastFailedAt: sql<
          string | null
        >`max(${commerceOutcomeSyncs.updatedAt}) FILTER (WHERE ${commerceOutcomeSyncs.state} = 'failed' AND ${commerceOutcomeSyncs.updatedAt} >= ${sinceIso})`,
        requiresAssistance: sql<boolean>`coalesce(bool_or(${commerceOutcomeSyncs.requiresAssistance}) FILTER (WHERE ${commerceOutcomeSyncs.state} = 'failed' AND ${commerceOutcomeSyncs.updatedAt} >= ${sinceIso}), false)`,
        pendingCount: sql<number>`count(*) FILTER (WHERE ${commerceOutcomeSyncs.state} = 'pending')::int`,
      })
      .from(commerceOutcomeSyncs)
      .where(
        and(
          eq(commerceOutcomeSyncs.orgId, orgId),
          eq(commerceOutcomeSyncs.integrationId, integrationId),
        ),
      );
    return {
      failedCount: row?.failedCount ?? 0,
      lastFailedAt: toIsoOrNull(row?.lastFailedAt),
      requiresAssistance: row?.requiresAssistance ?? false,
      pendingCount: row?.pendingCount ?? 0,
    };
  }

  /**
   * Gives a failed row a fresh set of tries. Answers the row only when it was
   * failed, so two retries at once start one.
   */
  async resetForRetry(
    id: string,
    orgId: string,
  ): Promise<CommerceOutcomeSync | undefined> {
    const [row] = await this.db
      .update(commerceOutcomeSyncs)
      .set({
        state: 'pending',
        attempts: 0,
        deferrals: 0,
        errorCode: null,
        requiresAssistance: false,
        nextAttemptAt: null,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(commerceOutcomeSyncs.id, id),
          eq(commerceOutcomeSyncs.orgId, orgId),
          eq(commerceOutcomeSyncs.state, 'failed'),
        ),
      )
      .returning();
    return row;
  }

  async findByIdForOrg(
    id: string,
    orgId: string,
  ): Promise<CommerceOutcomeSync | undefined> {
    const [row] = await this.db
      .select()
      .from(commerceOutcomeSyncs)
      .where(
        and(
          eq(commerceOutcomeSyncs.id, id),
          eq(commerceOutcomeSyncs.orgId, orgId),
        ),
      )
      .limit(1);
    return row;
  }

  /** The rows of one page of verifications, in one query. */
  async findByCorrelationIds(
    orgId: string,
    correlationIds: readonly string[],
  ): Promise<CommerceOutcomeSync[]> {
    if (correlationIds.length === 0) return [];
    return this.db
      .select()
      .from(commerceOutcomeSyncs)
      .where(
        and(
          eq(commerceOutcomeSyncs.orgId, orgId),
          inArray(commerceOutcomeSyncs.correlationId, [...correlationIds]),
        ),
      );
  }

  /** At most one row per action, so at most five. */
  async findForOrder(
    orgId: string,
    integrationId: string,
    orderId: string,
  ): Promise<CommerceOutcomeSync[]> {
    return this.db
      .select()
      .from(commerceOutcomeSyncs)
      .where(
        and(
          eq(commerceOutcomeSyncs.orgId, orgId),
          eq(commerceOutcomeSyncs.integrationId, integrationId),
          eq(commerceOutcomeSyncs.orderId, orderId),
        ),
      );
  }
}
