import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import {
  databaseErrorCode,
  withSerializableRetry,
} from '../../../shared/database/serializable-retry';
import {
  decideAdminEnable,
  decideMerchantAction,
} from '../../../shared/review-prompt/review-prompt.policy';
import type { ReviewPromptMerchantAction } from '../../../shared/review-prompt/review-prompt.types';
import { DRIZZLE, type DrizzleDB } from '../database.provider';
import {
  adminAccessAudit,
  integrations,
  reviewPromptEvents,
  reviewPromptRequests,
} from '../schema';

type Transaction = Parameters<Parameters<DrizzleDB['transaction']>[0]>[0];

export type ReviewPromptEventRecord = typeof reviewPromptEvents.$inferSelect;

export interface ReviewPromptStaffAudit {
  userId: string;
  requestId?: string;
}

export interface ReviewPromptMerchantScope {
  orgId: string;
  integrationId: string;
  requestId: string;
  actorId: string;
  httpRequestId?: string;
}

export type ReviewPromptEnableResult =
  | { outcome: 'not_found' | 'opted_out' | 'unsupported_platform' }
  | { outcome: 'created' | 'already_pending'; requestId: string };

export type ReviewPromptDisableResult = {
  outcome: 'not_found' | 'not_pending' | 'disabled';
};

export type ReviewPromptMerchantResult = {
  outcome: 'not_found' | 'conflict' | 'recorded' | 'replayed';
};

export type ReviewPromptShownResult = {
  outcome: 'not_found' | 'not_pending' | 'recorded' | 'replayed';
};

export interface ReviewPromptAdminState {
  platformType: string;
  pending: { id: string; enabledAt: string; enabledBy: string } | null;
  optedOutAt: string | null;
  events: ReviewPromptEventRecord[];
}

const ADMIN_EVENT_LIMIT = 20;

/**
 * The review prompt's requests and history. Every write is one transaction:
 * the request row and its event (and, for staff, the audit row) are written
 * together or not at all, so a failed write leaves the request pending for a
 * retry.
 */
@Injectable()
export class ReviewPromptsRepository {
  constructor(
    @Inject(DRIZZLE)
    private readonly db: DrizzleDB,
  ) {}

  /**
   * Staff open a request for one store. The store row is locked so two staff
   * switching it on at once produce one request.
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
      const decision = decideAdminEnable({
        platformType: store.platformType,
        optedOut: Boolean(await this.findOptOutAt(tx, integrationId)),
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

  /** Staff close the store's pending request before the merchant answers. */
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
   * Records the merchant's answer and closes the request in one transaction.
   * The request is found only within the caller's org and store, so an id
   * from another store is not found.
   */
  recordMerchantAction(
    scope: ReviewPromptMerchantScope,
    action: ReviewPromptMerchantAction,
  ): Promise<ReviewPromptMerchantResult> {
    return this.atomically(async (tx) => {
      const request = await this.lockScopedRequest(tx, scope);
      if (!request) return { outcome: 'not_found' };

      const decision = decideMerchantAction(request, action);
      if (decision === 'replay') return { outcome: 'replayed' };
      if (decision === 'conflict') return { outcome: 'conflict' };

      const now = new Date().toISOString();
      await tx.insert(reviewPromptEvents).values({
        requestId: request.id,
        orgId: scope.orgId,
        integrationId: scope.integrationId,
        event: action,
        actorType: 'merchant',
        actorId: scope.actorId,
        httpRequestId: scope.httpRequestId,
      });
      await tx
        .update(reviewPromptRequests)
        .set({
          status: 'answered',
          closedAction: action,
          closedAt: now,
          closedBy: scope.actorId,
          updatedAt: now,
        })
        .where(eq(reviewPromptRequests.id, request.id));
      return { outcome: 'recorded' };
    });
  }

  /** Records the banner's first impression for a pending request, once. */
  recordShown(
    scope: ReviewPromptMerchantScope,
  ): Promise<ReviewPromptShownResult> {
    return this.atomically(async (tx) => {
      const request = await this.lockScopedRequest(tx, scope);
      if (!request) return { outcome: 'not_found' };
      if (request.status !== 'pending') return { outcome: 'not_pending' };

      const inserted = await tx
        .insert(reviewPromptEvents)
        .values({
          requestId: request.id,
          orgId: scope.orgId,
          integrationId: scope.integrationId,
          event: 'shown',
          actorType: 'merchant',
          actorId: scope.actorId,
          httpRequestId: scope.httpRequestId,
        })
        .onConflictDoNothing()
        .returning({ id: reviewPromptEvents.id });
      return { outcome: inserted.length > 0 ? 'recorded' : 'replayed' };
    });
  }

  /** The store's open request, scoped to the merchant's org. */
  async findPending(
    orgId: string,
    integrationId: string,
  ): Promise<{ id: string } | undefined> {
    const [row] = await this.db
      .select({ id: reviewPromptRequests.id })
      .from(reviewPromptRequests)
      .where(
        and(
          eq(reviewPromptRequests.orgId, orgId),
          eq(reviewPromptRequests.integrationId, integrationId),
          eq(reviewPromptRequests.status, 'pending'),
        ),
      )
      .limit(1);
    return row;
  }

  /** The switch, the opt-out and the latest events of one store, for staff. */
  async findAdminState(
    integrationId: string,
  ): Promise<ReviewPromptAdminState | undefined> {
    const [store] = await this.db
      .select({ platformType: integrations.platformType })
      .from(integrations)
      .where(eq(integrations.id, integrationId));
    if (!store) return undefined;

    const [pending, optedOutAt, events] = await Promise.all([
      this.findPendingRow(this.db, integrationId),
      this.findOptOutAt(this.db, integrationId),
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
      platformType: store.platformType,
      pending: pending ?? null,
      optedOutAt,
      events,
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

  private async lockScopedRequest(
    tx: Transaction,
    scope: ReviewPromptMerchantScope,
  ) {
    const [request] = await tx
      .select({
        id: reviewPromptRequests.id,
        status: reviewPromptRequests.status,
        closedAction: reviewPromptRequests.closedAction,
      })
      .from(reviewPromptRequests)
      .where(
        and(
          eq(reviewPromptRequests.id, scope.requestId),
          eq(reviewPromptRequests.orgId, scope.orgId),
          eq(reviewPromptRequests.integrationId, scope.integrationId),
        ),
      )
      .for('update');
    return request;
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

  private async findOptOutAt(
    executor: Transaction | DrizzleDB,
    integrationId: string,
  ): Promise<string | null> {
    const [row] = await executor
      .select({ closedAt: reviewPromptRequests.closedAt })
      .from(reviewPromptRequests)
      .where(
        and(
          eq(reviewPromptRequests.integrationId, integrationId),
          eq(reviewPromptRequests.closedAction, 'dont_ask_again'),
        ),
      )
      .orderBy(desc(reviewPromptRequests.closedAt))
      .limit(1);
    return row?.closedAt ?? null;
  }

  private async insertStaffRecords(
    tx: Transaction,
    params: {
      event: 'enabled' | 'admin_disabled';
      requestId: string;
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
      action:
        params.event === 'enabled'
          ? 'store.review-prompt.enable'
          : 'store.review-prompt.disable',
      outcome: 'allowed',
      requestId: params.audit.requestId,
      targetIntegrationId: params.integrationId,
      metadata: { orgId: params.orgId, reviewPromptId: params.requestId },
    });
  }
}
