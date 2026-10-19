import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import {
  databaseErrorCode,
  withSerializableRetry,
} from '../../../shared/database/serializable-retry';
import {
  decideAdminEnable,
  decideMerchantEvent,
  type ReviewPromptChange,
} from '../../../shared/review-prompt/review-prompt.policy';
import type {
  ReviewPromptMerchantAction,
  ReviewRequestCode,
} from '../../../shared/review-prompt/review-prompt.types';
import { DRIZZLE, type DrizzleDB } from '../database.provider';
import {
  adminAccessAudit,
  integrations,
  reviewPromptEvents,
  reviewPromptRequests,
  reviewPromptStates,
} from '../schema';

type Transaction = Parameters<Parameters<DrizzleDB['transaction']>[0]>[0];

export type ReviewPromptEventRecord = typeof reviewPromptEvents.$inferSelect;
export type ReviewPromptStateRecord = typeof reviewPromptStates.$inferSelect;

export interface ReviewPromptStaffAudit {
  userId: string;
  requestId?: string;
}

export interface ReviewPromptMerchantScope {
  orgId: string;
  integrationId: string;
  actorId: string;
  httpRequestId?: string;
}

export type ReviewPromptEnableResult =
  | { outcome: 'not_found' | 'opted_out' | 'unsupported_platform' }
  | { outcome: 'created' | 'already_pending'; requestId: string };

export type ReviewPromptDisableResult = {
  outcome: 'not_found' | 'not_pending' | 'disabled';
};

export type ReviewPromptResetResult = {
  outcome: 'not_found' | 'unsupported_platform' | 'reset';
};

export type ReviewPromptMerchantResult = { outcome: 'recorded' | 'replayed' };

export interface ReviewPromptMerchantView {
  switchedOn: boolean;
  state: ReviewPromptStateRecord | undefined;
}

/** The store's customer outcomes since its current installation started. */
export interface ReviewPromptStoreResults {
  confirmed: number;
  canceled: number;
  since: string;
}

export interface ReviewPromptAdminState {
  orgId: string;
  platformType: string;
  pending: { id: string; enabledAt: string; enabledBy: string } | null;
  state: ReviewPromptStateRecord | undefined;
  events: ReviewPromptEventRecord[];
}

const ADMIN_EVENT_LIMIT = 20;

/**
 * The review prompt's switch, per-store state and history. Every write is one
 * transaction: the state row and its event (and, for staff, the audit row)
 * are written together or not at all.
 */
@Injectable()
export class ReviewPromptsRepository {
  constructor(
    @Inject(DRIZZLE)
    private readonly db: DrizzleDB,
  ) {}

  /**
   * Staff switch the prompt on for one store. The store row is locked so two
   * staff switching it on at once produce one request. A store that declined
   * stays off until staff reset it.
   */
  enable(
    integrationId: string,
    audit: ReviewPromptStaffAudit,
  ): Promise<ReviewPromptEnableResult> {
    return this.atomically(async (tx) => {
      const [store] = await tx
        .select({
          orgId: integrations.orgId,
          platformType: integrations.platformType,
        })
        .from(integrations)
        .where(eq(integrations.id, integrationId))
        .for('update');
      if (!store) return { outcome: 'not_found' };

      const pending = await this.findPendingRow(tx, integrationId);
      const state = await this.findStateRow(tx, integrationId);
      const decision = decideAdminEnable({
        platformType: store.platformType,
        optedOut: state?.state === 'declined',
        hasPending: Boolean(pending),
      });
      if (decision === 'opted_out' || decision === 'unsupported_platform') {
        return { outcome: decision };
      }
      if (pending) return { outcome: 'already_pending', requestId: pending.id };

      const [created] = await tx
        .insert(reviewPromptRequests)
        .values({
          orgId: store.orgId,
          integrationId,
          enabledBy: audit.userId,
        })
        .returning({ id: reviewPromptRequests.id });
      await this.insertStaffRecords(tx, {
        event: 'enabled',
        requestId: created.id,
        orgId: store.orgId,
        integrationId,
        audit,
      });
      return { outcome: 'created', requestId: created.id };
    });
  }

  /** Staff switch the prompt off. The merchant's state is left as it is. */
  disable(
    integrationId: string,
    audit: ReviewPromptStaffAudit,
  ): Promise<ReviewPromptDisableResult> {
    return this.atomically(async (tx) => {
      const [store] = await tx
        .select({ orgId: integrations.orgId })
        .from(integrations)
        .where(eq(integrations.id, integrationId))
        .for('update');
      if (!store) return { outcome: 'not_found' };

      const pending = await this.findPendingRow(tx, integrationId);
      if (!pending) return { outcome: 'not_pending' };

      const now = new Date().toISOString();
      await tx
        .update(reviewPromptRequests)
        .set({
          status: 'admin_disabled',
          closedAction: 'admin_disabled',
          closedAt: now,
          closedBy: audit.userId,
          updatedAt: now,
        })
        .where(eq(reviewPromptRequests.id, pending.id));
      await this.insertStaffRecords(tx, {
        event: 'admin_disabled',
        requestId: pending.id,
        orgId: store.orgId,
        integrationId,
        audit,
      });
      return { outcome: 'disabled' };
    });
  }

  /**
   * Staff make a snoozed, declined, clicked or reviewed prompt eligible again.
   * The switch is not touched: a prompt that is on shows on the next visit.
   */
  reset(
    integrationId: string,
    audit: ReviewPromptStaffAudit,
  ): Promise<ReviewPromptResetResult> {
    return this.atomically(async (tx) => {
      const [store] = await tx
        .select({
          orgId: integrations.orgId,
          platformType: integrations.platformType,
        })
        .from(integrations)
        .where(eq(integrations.id, integrationId))
        .for('update');
      if (!store) return { outcome: 'not_found' };
      if (store.platformType !== 'shopify') {
        return { outcome: 'unsupported_platform' };
      }

      const now = new Date().toISOString();
      await tx
        .insert(reviewPromptStates)
        .values({ integrationId, orgId: store.orgId })
        .onConflictDoUpdate({
          target: reviewPromptStates.integrationId,
          set: {
            state: 'eligible',
            snoozedUntil: null,
            snoozeCount: 0,
            updatedAt: now,
          },
        });
      const pending = await this.findPendingRow(tx, integrationId);
      await this.insertStaffRecords(tx, {
        event: 'reset',
        requestId: pending?.id ?? null,
        orgId: store.orgId,
        integrationId,
        audit,
      });
      return { outcome: 'reset' };
    });
  }

  /**
   * Applies one merchant report to the store's state and logs it, in one
   * transaction. The state row is created on first use and locked, so two
   * tabs reporting at once apply one after the other and the later one wins.
   */
  recordMerchantEvent(
    scope: ReviewPromptMerchantScope,
    action: ReviewPromptMerchantAction,
    code?: ReviewRequestCode,
  ): Promise<ReviewPromptMerchantResult> {
    return this.atomically(async (tx) => {
      await tx
        .insert(reviewPromptStates)
        .values({ integrationId: scope.integrationId, orgId: scope.orgId })
        .onConflictDoNothing();
      const [row] = await tx
        .select()
        .from(reviewPromptStates)
        .where(
          and(
            eq(reviewPromptStates.integrationId, scope.integrationId),
            eq(reviewPromptStates.orgId, scope.orgId),
          ),
        )
        .for('update');

      const decision = decideMerchantEvent(row, action, new Date(), code);
      if (decision.kind === 'replay') return { outcome: 'replayed' };

      const now = new Date().toISOString();
      await tx
        .update(reviewPromptStates)
        .set({ ...this.stateUpdate(decision.change, now), updatedAt: now })
        .where(
          and(
            eq(reviewPromptStates.integrationId, scope.integrationId),
            eq(reviewPromptStates.orgId, scope.orgId),
          ),
        );
      const pending = await this.findPendingRow(tx, scope.integrationId);
      await tx.insert(reviewPromptEvents).values({
        requestId: pending?.id ?? null,
        orgId: scope.orgId,
        integrationId: scope.integrationId,
        event: decision.change.event,
        actorType: 'merchant',
        actorId: scope.actorId,
        httpRequestId: scope.httpRequestId,
        resultCode: decision.change.lastResultCode ?? null,
      });
      return { outcome: 'recorded' };
    });
  }

  /** The switch and the state of one store, scoped to the merchant's org. */
  async findMerchantView(
    orgId: string,
    integrationId: string,
  ): Promise<ReviewPromptMerchantView> {
    const [pending, state] = await Promise.all([
      this.db
        .select({ id: reviewPromptRequests.id })
        .from(reviewPromptRequests)
        .where(
          and(
            eq(reviewPromptRequests.orgId, orgId),
            eq(reviewPromptRequests.integrationId, integrationId),
            eq(reviewPromptRequests.status, 'pending'),
          ),
        )
        .limit(1),
      this.db
        .select()
        .from(reviewPromptStates)
        .where(
          and(
            eq(reviewPromptStates.orgId, orgId),
            eq(reviewPromptStates.integrationId, integrationId),
          ),
        )
        .limit(1),
    ]);
    return { switchedOn: pending.length > 0, state: state[0] };
  }

  /**
   * Customer-confirmed and customer-canceled orders of one store since its
   * current installation started (its open lifecycle, else its latest one,
   * else the store row's creation). Test and onboarding orders, merchant
   * confirmations and cancellations, and no-reply outcomes are not counted.
   * Undefined when the store is not in the org.
   */
  async countStoreResults(
    orgId: string,
    integrationId: string,
  ): Promise<ReviewPromptStoreResults | undefined> {
    const result = await this.db.execute<{
      since: string | Date;
      confirmed: number;
      canceled: number;
    }>(sql`
      WITH store AS (
        SELECT
          i.id,
          i.org_id,
          COALESCE(
            (
              SELECT l.installed_at
              FROM admin_store_lifecycles l
              WHERE l.integration_id = i.id
              ORDER BY (l.uninstalled_at IS NULL) DESC, l.installed_at DESC
              LIMIT 1
            ),
            i.created_at
          ) AS since
        FROM integrations i
        WHERE i.id = ${integrationId} AND i.org_id = ${orgId}
      )
      SELECT
        store.since,
        COUNT(v.id) FILTER (
          WHERE v.confirmed_at IS NOT NULL
            AND v.confirmation_source IS DISTINCT FROM 'merchant_manual'
        )::int AS confirmed,
        COUNT(v.id) FILTER (
          WHERE v.canceled_at IS NOT NULL
            AND (v.cancellation_source IS NULL OR v.cancellation_source = 'customer')
        )::int AS canceled
      FROM store
      LEFT JOIN orders ord
        ON ord.integration_id = store.id
        AND ord.org_id = store.org_id
        AND NOT ord.is_test
        AND ord.external_order_id NOT LIKE 'akeed-test-%'
      LEFT JOIN verifications v
        ON v.order_id = ord.id
        AND v.org_id = store.org_id
        AND v.created_at >= store.since
      GROUP BY store.since
    `);
    const [row] = Array.from(result);
    if (!row) return undefined;
    return {
      confirmed: row.confirmed,
      canceled: row.canceled,
      since: new Date(row.since).toISOString(),
    };
  }

  /** The switch, the state and the latest events of one store, for staff. */
  async findAdminState(
    integrationId: string,
  ): Promise<ReviewPromptAdminState | undefined> {
    const [store] = await this.db
      .select({
        orgId: integrations.orgId,
        platformType: integrations.platformType,
      })
      .from(integrations)
      .where(eq(integrations.id, integrationId));
    if (!store) return undefined;

    const [pending, state, events] = await Promise.all([
      this.findPendingRow(this.db, integrationId),
      this.findStateRow(this.db, integrationId),
      this.db
        .select()
        .from(reviewPromptEvents)
        .where(eq(reviewPromptEvents.integrationId, integrationId))
        .orderBy(
          desc(reviewPromptEvents.createdAt),
          desc(reviewPromptEvents.id),
        )
        .limit(ADMIN_EVENT_LIMIT),
    ]);
    return {
      orgId: store.orgId,
      platformType: store.platformType,
      pending: pending ?? null,
      state,
      events,
    };
  }

  private stateUpdate(
    change: ReviewPromptChange,
    now: string,
  ): PgUpdateSetSource<typeof reviewPromptStates> {
    return {
      ...(change.state !== undefined && { state: change.state }),
      ...(change.snoozedUntil !== undefined && {
        snoozedUntil: change.snoozedUntil,
      }),
      ...(change.snoozeCount !== undefined && {
        snoozeCount: change.snoozeCount,
      }),
      ...(change.lastResultCode !== undefined && {
        lastResultCode: change.lastResultCode,
      }),
      ...(change.shown && {
        shownCount: sql`${reviewPromptStates.shownCount} + 1`,
        lastShownAt: now,
      }),
    };
  }

  /**
   * Runs one write transaction, retrying a serialization failure or deadlock.
   * A unique violation means a concurrent writer committed the same change
   * first, so the work runs once more and sees it.
   */
  private async atomically<T>(
    work: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    const run = () => withSerializableRetry(() => this.db.transaction(work));
    try {
      return await run();
    } catch (error) {
      if (databaseErrorCode(error) !== '23505') throw error;
      return run();
    }
  }

  private async findPendingRow(
    executor: Transaction | DrizzleDB,
    integrationId: string,
  ) {
    const [row] = await executor
      .select({
        id: reviewPromptRequests.id,
        enabledAt: reviewPromptRequests.enabledAt,
        enabledBy: reviewPromptRequests.enabledBy,
      })
      .from(reviewPromptRequests)
      .where(
        and(
          eq(reviewPromptRequests.integrationId, integrationId),
          eq(reviewPromptRequests.status, 'pending'),
        ),
      )
      .limit(1);
    return row;
  }

  private async findStateRow(
    executor: Transaction | DrizzleDB,
    integrationId: string,
  ) {
    const [row] = await executor
      .select()
      .from(reviewPromptStates)
      .where(eq(reviewPromptStates.integrationId, integrationId))
      .limit(1);
    return row;
  }

  private async insertStaffRecords(
    tx: Transaction,
    params: {
      event: 'enabled' | 'admin_disabled' | 'reset';
      requestId: string | null;
      orgId: string;
      integrationId: string;
      audit: ReviewPromptStaffAudit;
    },
  ): Promise<void> {
    await tx.insert(reviewPromptEvents).values({
      requestId: params.requestId,
      orgId: params.orgId,
      integrationId: params.integrationId,
      event: params.event,
      actorType: 'admin',
      actorId: params.audit.userId,
      httpRequestId: params.audit.requestId,
    });
    await tx.insert(adminAccessAudit).values({
      userId: params.audit.userId,
      action: STAFF_AUDIT_ACTIONS[params.event],
      outcome: 'allowed',
      requestId: params.audit.requestId,
      targetIntegrationId: params.integrationId,
      metadata: { orgId: params.orgId, reviewPromptId: params.requestId },
    });
  }
}

const STAFF_AUDIT_ACTIONS = {
  enabled: 'store.review-prompt.enable',
  admin_disabled: 'store.review-prompt.disable',
  reset: 'store.review-prompt.reset',
} as const;
