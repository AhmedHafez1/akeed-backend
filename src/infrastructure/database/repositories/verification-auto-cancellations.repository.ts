import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNotNull,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database.provider';
import {
  integrations,
  orders,
  verificationAutoCancellationEvents,
  verificationAutoCancellations,
  verificationMessageDispatches,
  verifications,
} from '../schema';
import type { CommerceOutcomeOperationResult } from '../../../shared/commerce/commerce-outcome';
import {
  AUTO_CANCEL_COMMITTED_STATUSES,
  AUTO_CANCEL_STOPPABLE_STATUSES,
  AUTOMATIC_CANCELLATION_SOURCE,
  type AutoCancelEvent,
  type AutoCancelStatus,
  type AutoCancelStopReason,
} from '../../../shared/verification/auto-cancel.policy';

type Transaction = Parameters<Parameters<DrizzleDB['transaction']>[0]>[0];
type Writer = DrizzleDB | Transaction;

export type AutoCancellationRow =
  typeof verificationAutoCancellations.$inferSelect;
export type AutoCancellationPatch = Partial<
  Omit<
    typeof verificationAutoCancellations.$inferInsert,
    'id' | 'orgId' | 'verificationId' | 'createdAt'
  >
>;

/** Everything a decision about one order reads, taken in one place. */
export interface AutoCancelSnapshot {
  verification: Pick<
    typeof verifications.$inferSelect,
    | 'id'
    | 'orgId'
    | 'orderId'
    | 'status'
    | 'confirmedAt'
    | 'canceledAt'
    | 'merchantCanceledAt'
    | 'customerLastMessageAt'
    | 'autoCancelExcludedAt'
    | 'followUpAttempts'
    | 'followUpSentAt'
    | 'deliveredAt'
    | 'readAt'
    | 'metadata'
  >;
  order: {
    id: string;
    integrationId: string;
    externalOrderId: string;
    isTest: boolean | null;
  };
  integration: Pick<
    typeof integrations.$inferSelect,
    | 'id'
    | 'platformType'
    | 'autoCancelEnabled'
    | 'autoCancelRestock'
    | 'autoCancelNotifyCustomer'
    | 'quietHoursEnabled'
    | 'quietHoursStart'
    | 'quietHoursEnd'
    | 'timezone'
  >;
  /** First delivery or read receipt of the confirmation message. */
  initialDeliveredAt: string | null;
  /** First delivery or read receipt of the reminder. */
  followUpDeliveredAt: string | null;
  row: AutoCancellationRow | null;
}

export interface AutoCancelEventInput {
  orgId: string;
  verificationId: string;
  event: AutoCancelEvent;
  actorUserId?: string | null;
  detail?: Record<string, unknown>;
}

/** Statuses of an order still waiting for the customer's answer. */
const OPEN_VERIFICATION_STATUSES = [
  'sent',
  'delivered',
  'read',
  'no_reply',
  'no_whatsapp',
] as const;

/** How far back a message from a number is matched to its orders. */
const CUSTOMER_MESSAGE_MATCH_MS = 7 * 24 * 60 * 60_000;

/**
 * Automatic cancellations and their audit trail.
 *
 * Every decision is taken inside `withLockedVerification`: the verification
 * row is locked first and the cancellation row second, in that order on every
 * path, so a customer's reply, a merchant's exclusion and the worker that
 * cancels can never interleave. The customer-message hook and the settings
 * switch take the same locks.
 */
@Injectable()
export class VerificationAutoCancellationsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async findById(id: string): Promise<AutoCancellationRow | undefined> {
    const [row] = await this.db
      .select()
      .from(verificationAutoCancellations)
      .where(eq(verificationAutoCancellations.id, id))
      .limit(1);
    return row;
  }

  async findByVerification(
    verificationId: string,
    orgId: string,
  ): Promise<AutoCancellationRow | undefined> {
    const [row] = await this.db
      .select()
      .from(verificationAutoCancellations)
      .where(
        and(
          eq(verificationAutoCancellations.verificationId, verificationId),
          eq(verificationAutoCancellations.orgId, orgId),
        ),
      )
      .limit(1);
    return row;
  }

  /** The rows of one page of the confirmations list. */
  async findByVerificationIds(
    orgId: string,
    verificationIds: readonly string[],
  ): Promise<AutoCancellationRow[]> {
    if (verificationIds.length === 0) return [];
    return this.db
      .select()
      .from(verificationAutoCancellations)
      .where(
        and(
          eq(verificationAutoCancellations.orgId, orgId),
          inArray(verificationAutoCancellations.verificationId, [
            ...verificationIds,
          ]),
        ),
      );
  }

  /**
   * Runs `work` with the verification and its cancellation row locked. Null
   * when the verification, its order or its source is gone.
   */
  async withLockedVerification<T>(
    verificationId: string,
    work: (snapshot: AutoCancelSnapshot, tx: Transaction) => Promise<T>,
  ): Promise<T | null> {
    return this.db.transaction(async (tx) => {
      const snapshot = await this.readSnapshot(tx, verificationId, true);
      if (!snapshot) return null;
      return work(snapshot, tx);
    });
  }

  /** The same facts without locks, for a read-only projection. */
  async readSnapshotUnlocked(
    verificationId: string,
  ): Promise<AutoCancelSnapshot | null> {
    return this.readSnapshot(this.db, verificationId, false);
  }

  /** Creates the row once per verification; a second call returns null. */
  async insert(
    tx: Writer,
    values: typeof verificationAutoCancellations.$inferInsert,
  ): Promise<AutoCancellationRow | null> {
    const [row] = await tx
      .insert(verificationAutoCancellations)
      .values(values)
      .onConflictDoNothing({
        target: verificationAutoCancellations.verificationId,
      })
      .returning();
    return row ?? null;
  }

  async update(
    tx: Writer,
    id: string,
    patch: AutoCancellationPatch,
  ): Promise<AutoCancellationRow | null> {
    const [row] = await tx
      .update(verificationAutoCancellations)
      .set({ ...patch, updatedAt: new Date().toISOString() })
      .where(eq(verificationAutoCancellations.id, id))
      .returning();
    return row ?? null;
  }

  async appendEvent(tx: Writer, input: AutoCancelEventInput): Promise<void> {
    await tx.insert(verificationAutoCancellationEvents).values({
      orgId: input.orgId,
      verificationId: input.verificationId,
      event: input.event,
      actorUserId: input.actorUserId ?? null,
      detail: input.detail ?? {},
    });
  }

  /**
   * The store confirmed the cancellation: the order moves to `canceled` with
   * the automatic source. Guarded on `no_reply`, so an answer or a merchant
   * action that won first is left as it is.
   */
  async markVerificationCanceled(
    tx: Transaction,
    verificationId: string,
    operation: CommerceOutcomeOperationResult,
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const rows = await tx
      .update(verifications)
      .set({
        status: 'canceled',
        canceledAt: now,
        cancellationSource: AUTOMATIC_CANCELLATION_SOURCE,
        metadata: sql`COALESCE(${verifications.metadata}, '{}'::jsonb) || ${JSON.stringify({ commerceCancellation: operation })}::jsonb`,
        updatedAt: now,
      })
      .where(
        and(
          eq(verifications.id, verificationId),
          eq(verifications.status, 'no_reply'),
        ),
      )
      .returning({ id: verifications.id });
    return rows.length > 0;
  }

  /** Keeps the order out of the automatic cancellation, or lets it back. */
  async setExclusion(
    tx: Transaction,
    verificationId: string,
    excludedBy: string | null,
  ): Promise<void> {
    await tx
      .update(verifications)
      .set({
        autoCancelExcludedAt: excludedBy ? new Date().toISOString() : null,
        autoCancelExcludedBy: excludedBy,
      })
      .where(eq(verifications.id, verificationId));
  }

  /** Scheduled cancellations whose time has come. */
  async listDue(now: string, limit: number): Promise<AutoCancellationRow[]> {
    return this.listWhere(
      and(
        eq(verificationAutoCancellations.status, 'scheduled'),
        lte(verificationAutoCancellations.dueAt, now),
      ),
      limit,
    );
  }

  /** Paused cancellations still worth re-checking. */
  async listPaused(
    createdSince: string,
    limit: number,
  ): Promise<AutoCancellationRow[]> {
    return this.listWhere(
      and(
        eq(verificationAutoCancellations.status, 'paused'),
        gte(verificationAutoCancellations.createdAt, createdSince),
      ),
      limit,
    );
  }

  /** Claimed cancellations whose worker stopped before finishing. */
  async listExpiredLeases(
    now: string,
    limit: number,
  ): Promise<AutoCancellationRow[]> {
    return this.listWhere(
      and(
        eq(verificationAutoCancellations.status, 'in_progress'),
        lte(verificationAutoCancellations.leaseUntil, now),
      ),
      limit,
    );
  }

  /** Cancellations the store accepted but has not confirmed yet. */
  async listAwaitingPlatform(limit: number): Promise<AutoCancellationRow[]> {
    return this.listWhere(
      eq(verificationAutoCancellations.status, 'awaiting_platform'),
      limit,
    );
  }

  /**
   * The setting was switched off: every cancellation that has not reached
   * the store stops, each with an audit event. One the store is already
   * handling runs to its end.
   */
  async stopPendingForIntegration(
    orgId: string,
    integrationId: string,
    reason: AutoCancelStopReason,
    actorUserId: string | null,
  ): Promise<number> {
    return this.db.transaction(async (tx) => {
      const stopped = await tx
        .update(verificationAutoCancellations)
        .set({
          status: 'stopped',
          reason,
          dueAt: null,
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(verificationAutoCancellations.orgId, orgId),
            eq(verificationAutoCancellations.integrationId, integrationId),
            inArray(verificationAutoCancellations.status, [
              ...AUTO_CANCEL_STOPPABLE_STATUSES,
            ]),
          ),
        )
        .returning({
          verificationId: verificationAutoCancellations.verificationId,
        });
      if (stopped.length > 0) {
        await tx.insert(verificationAutoCancellationEvents).values(
          stopped.map(({ verificationId }) => ({
            orgId,
            verificationId,
            event: 'stopped' as const,
            actorUserId,
            detail: { reason },
          })),
        );
      }
      return stopped.length;
    });
  }

  /**
   * A message came from a customer's number. Every open order it can belong
   * to records it: the one its button or quote names, and the recent orders
   * sent to that number in any store, because the shared sender cannot tell
   * which one a plain message is about. A cancellation that had not reached
   * the store stops; one that has is flagged for the merchant.
   *
   * Returns the verifications whose cancellation is committed, so the caller
   * leaves their status alone.
   */
  async recordCustomerMessage(input: {
    phoneE164: string | null;
    verificationIds: readonly string[];
    receivedAt: string;
  }): Promise<{ matched: string[]; committed: string[] }> {
    const since = new Date(
      new Date(input.receivedAt).getTime() - CUSTOMER_MESSAGE_MATCH_MS,
    ).toISOString();
    const named = [
      ...(input.verificationIds.length > 0
        ? [inArray(verifications.id, [...input.verificationIds])]
        : []),
      ...(input.phoneE164
        ? [
            and(
              eq(orders.customerPhone, input.phoneE164),
              gte(verifications.lastSentAt, since),
            ),
          ]
        : []),
    ];
    if (named.length === 0) return { matched: [], committed: [] };

    const candidates = await this.db
      .select({ id: verifications.id })
      .from(verifications)
      .innerJoin(orders, eq(orders.id, verifications.orderId))
      .leftJoin(
        verificationAutoCancellations,
        eq(verificationAutoCancellations.verificationId, verifications.id),
      )
      .where(
        and(
          or(...named),
          or(
            inArray(verifications.status, [...OPEN_VERIFICATION_STATUSES]),
            inArray(verificationAutoCancellations.status, [
              ...AUTO_CANCEL_COMMITTED_STATUSES,
            ]),
          ),
        ),
      )
      .orderBy(asc(verifications.id))
      .limit(20);

    const matched: string[] = [];
    const committed: string[] = [];
    for (const { id } of candidates) {
      await this.db.transaction(async (tx) => {
        const [locked] = await tx
          .select({
            id: verifications.id,
            orgId: verifications.orgId,
            status: verifications.status,
          })
          .from(verifications)
          .where(eq(verifications.id, id))
          .for('update');
        if (!locked) return;
        await tx
          .update(verifications)
          .set({
            customerLastMessageAt: sql`GREATEST(COALESCE(${verifications.customerLastMessageAt}, ${input.receivedAt}::timestamptz), ${input.receivedAt}::timestamptz)`,
          })
          .where(eq(verifications.id, id));
        matched.push(id);

        const [row] = await tx
          .select()
          .from(verificationAutoCancellations)
          .where(eq(verificationAutoCancellations.verificationId, id))
          .for('update');
        if (!row) return;
        if (
          (AUTO_CANCEL_STOPPABLE_STATUSES as readonly string[]).includes(
            row.status,
          )
        ) {
          await this.update(tx, row.id, {
            status: 'stopped',
            reason: 'customer_reply',
            dueAt: null,
          });
          await this.appendEvent(tx, {
            orgId: locked.orgId,
            verificationId: id,
            event: 'stopped',
            detail: { reason: 'customer_reply' },
          });
        } else if (
          (AUTO_CANCEL_COMMITTED_STATUSES as readonly string[]).includes(
            row.status,
          )
        ) {
          committed.push(id);
          if (!row.lateReplyAt) {
            await this.update(tx, row.id, { lateReplyAt: input.receivedAt });
          }
          await this.appendEvent(tx, {
            orgId: locked.orgId,
            verificationId: id,
            event: 'late_reply',
            detail: { status: row.status },
          });
        }
      });
    }
    return { matched, committed };
  }

  private listWhere(
    where: ReturnType<typeof and>,
    limit: number,
  ): Promise<AutoCancellationRow[]> {
    return this.db
      .select()
      .from(verificationAutoCancellations)
      .where(where)
      .orderBy(asc(verificationAutoCancellations.dueAt))
      .limit(limit);
  }

  private async readSnapshot(
    tx: Writer,
    verificationId: string,
    lock: boolean,
  ): Promise<AutoCancelSnapshot | null> {
    const verificationQuery = tx
      .select({
        id: verifications.id,
        orgId: verifications.orgId,
        orderId: verifications.orderId,
        status: verifications.status,
        confirmedAt: verifications.confirmedAt,
        canceledAt: verifications.canceledAt,
        merchantCanceledAt: verifications.merchantCanceledAt,
        customerLastMessageAt: verifications.customerLastMessageAt,
        autoCancelExcludedAt: verifications.autoCancelExcludedAt,
        followUpAttempts: verifications.followUpAttempts,
        followUpSentAt: verifications.followUpSentAt,
        deliveredAt: verifications.deliveredAt,
        readAt: verifications.readAt,
        metadata: verifications.metadata,
      })
      .from(verifications)
      .where(eq(verifications.id, verificationId));
    const [verification] = lock
      ? await verificationQuery.for('update')
      : await verificationQuery;
    if (!verification) return null;

    const [order] = await tx
      .select({
        id: orders.id,
        integrationId: orders.integrationId,
        externalOrderId: orders.externalOrderId,
        isTest: orders.isTest,
      })
      .from(orders)
      .where(
        and(
          eq(orders.id, verification.orderId),
          eq(orders.orgId, verification.orgId),
        ),
      );
    if (!order?.integrationId || !order.externalOrderId) return null;

    const [integration] = await tx
      .select({
        id: integrations.id,
        platformType: integrations.platformType,
        autoCancelEnabled: integrations.autoCancelEnabled,
        autoCancelRestock: integrations.autoCancelRestock,
        autoCancelNotifyCustomer: integrations.autoCancelNotifyCustomer,
        quietHoursEnabled: integrations.quietHoursEnabled,
        quietHoursStart: integrations.quietHoursStart,
        quietHoursEnd: integrations.quietHoursEnd,
        timezone: integrations.timezone,
      })
      .from(integrations)
      .where(
        and(
          eq(integrations.id, order.integrationId),
          eq(integrations.orgId, verification.orgId),
        ),
      );
    if (!integration) return null;

    const dispatches = await tx
      .select({
        kind: verificationMessageDispatches.kind,
        deliveredAt: verificationMessageDispatches.deliveredAt,
        readAt: verificationMessageDispatches.readAt,
      })
      .from(verificationMessageDispatches)
      .where(
        and(
          eq(verificationMessageDispatches.verificationId, verificationId),
          isNotNull(verificationMessageDispatches.acceptedAt),
        ),
      );
    const firstReceipt = (kinds: readonly string[]) =>
      dispatches
        .filter((dispatch) => kinds.includes(dispatch.kind))
        .map((dispatch) => dispatch.deliveredAt ?? dispatch.readAt)
        .filter((at): at is string => Boolean(at))
        .sort()[0] ?? null;
    const followUpDeliveredAt = firstReceipt(['follow_up']);
    // A row sent before the dispatch ledger has only the verification's own
    // receipts, which describe the first message while no reminder went out.
    const initialDeliveredAt =
      firstReceipt(['initial', 'legacy_unknown']) ??
      ((verification.followUpAttempts ?? 0) === 0 &&
      !verification.followUpSentAt
        ? (verification.deliveredAt ?? verification.readAt ?? null)
        : null);

    const rowQuery = tx
      .select()
      .from(verificationAutoCancellations)
      .where(eq(verificationAutoCancellations.verificationId, verificationId));
    const [row] = lock ? await rowQuery.for('update') : await rowQuery;

    return {
      verification,
      order: {
        id: order.id,
        integrationId: order.integrationId,
        externalOrderId: order.externalOrderId,
        isTest: order.isTest,
      },
      integration,
      initialDeliveredAt,
      followUpDeliveredAt,
      row: row ?? null,
    };
  }

  /** True when the row's status says the store was, or is being, asked. */
  static isCommitted(status: AutoCancelStatus | null | undefined): boolean {
    return (
      status !== null &&
      status !== undefined &&
      (AUTO_CANCEL_COMMITTED_STATUSES as readonly string[]).includes(status)
    );
  }
}
