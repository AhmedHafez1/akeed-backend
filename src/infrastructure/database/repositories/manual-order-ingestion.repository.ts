import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../index';
import { DRIZZLE } from '../database.provider';
import { orders, webhookEvents } from '../schema';

type Database = PostgresJsDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** One transaction per chunk; a chunk is small enough to retry cheaply. */
export const ACCEPTANCE_CHUNK = 200;

export class ManualOrderPayloadConflictError extends Error {
  constructor() {
    super('The idempotency key was already used with different order data');
    this.name = ManualOrderPayloadConflictError.name;
  }
}

export class ManualOrderAcceptanceStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = ManualOrderAcceptanceStateError.name;
  }
}

/**
 * A new idempotency key for an order identity the source already has, whose
 * content differs from the stored order. Nothing is written.
 */
export class ManualOrderIdentityConflictError extends Error {
  constructor() {
    super('The order identity already exists with different order data');
    this.name = ManualOrderIdentityConflictError.name;
  }
}

/**
 * Rolls one row's savepoint back without failing its chunk.
 *
 * Thrown inside the per-row nested transaction when the order identity is
 * already owned by someone else, so Postgres discards that row's event insert
 * along with the losing order insert. Never escapes `acceptMany`.
 */
class RowRollback extends Error {
  constructor() {
    super('row rolled back to its savepoint');
    this.name = RowRollback.name;
  }
}

/**
 * Rolls a non-held acceptance back and answers with the order that already
 * owns the identity.
 *
 * Thrown inside the acceptance transaction when a new idempotency key carries
 * an order the source already has, with identical content. The rollback
 * discards the event just inserted, so a replay leaves no second event to be
 * dispatched or swept. Never escapes `accept`.
 */
class IdentityReplayRollback extends Error {
  constructor(
    readonly existing: { eventId: string; order: typeof orders.$inferSelect },
  ) {
    super('acceptance rolled back to replay the existing order');
    this.name = IdentityReplayRollback.name;
  }
}

/**
 * Which identity a duplicate was recognised by: the request's own idempotency
 * key (`event_key`, the same request again) or the order's external identity
 * under a new key (`external_id`, the same order again).
 */
export type AcceptanceReplayKind = 'event_key' | 'external_id';

export interface ManualOrderAcceptanceInput {
  event: {
    idempotencyKey: string;
    storeDomain: string;
    orgId: string;
    integrationId: string;
    rawPayload: Record<string, unknown>;
    submissionFingerprint: string;
    /**
     * Persist the event held: not dispatchable until `releaseHeld`. Omitted,
     * the event is dispatchable immediately, exactly as before holds existed.
     */
    hold?: { groupId: string };
  };
  order: typeof orders.$inferInsert;
}

export interface ManualOrderAcceptanceResult {
  eventId: string;
  order: typeof orders.$inferSelect;
  duplicate: boolean;
  /** Set on a duplicate only. An `external_id` replay owns no event of its own. */
  replay?: AcceptanceReplayKind;
}

/**
 * One row's outcome.
 *
 * `already_imported` only ever occurs on a held (bulk) acceptance: an import
 * racing another batch for the same merchant reference is an ordinary,
 * expected outcome the caller reports per row. A non-held acceptance that
 * meets an existing identity replays it or throws
 * `ManualOrderIdentityConflictError` instead.
 */
export type AcceptanceRowResult =
  | ({ status: 'accepted' } & ManualOrderAcceptanceResult)
  | { status: 'already_imported' };

type AcceptedRow = { status: 'accepted' } & ManualOrderAcceptanceResult;

@Injectable()
export class ManualOrderIngestionRepository {
  constructor(
    @Inject(DRIZZLE)
    private readonly db: Database,
  ) {}

  async accept(
    input: ManualOrderAcceptanceInput,
  ): Promise<ManualOrderAcceptanceResult> {
    let result: AcceptanceRowResult;
    try {
      result = await this.db.transaction((tx) =>
        this.acceptWithinTransaction(tx, input),
      );
    } catch (error) {
      if (!(error instanceof IdentityReplayRollback)) throw error;
      result = {
        status: 'accepted',
        ...error.existing,
        duplicate: true,
        replay: 'external_id',
      };
    }
    if (result.status === 'already_imported') {
      // Unreachable without `hold`; kept so the union stays total and a future
      // held caller of `accept()` fails loudly instead of silently.
      throw new ManualOrderAcceptanceStateError(
        'The generated manual order identity already exists',
      );
    }
    await this.assertPersisted([result.order.id]);
    return result;
  }

  /**
   * Accept a batch of held orders, one transaction per chunk.
   *
   * Each row runs in its own savepoint, so a row that loses the race for a
   * merchant reference rolls back alone -- its event insert included -- and the
   * rest of the chunk still commits. Results are returned in input order.
   */
  async acceptMany(
    inputs: ManualOrderAcceptanceInput[],
    options: { hold: { groupId: string } },
  ): Promise<AcceptanceRowResult[]> {
    const results: AcceptanceRowResult[] = [];
    for (let start = 0; start < inputs.length; start += ACCEPTANCE_CHUNK) {
      const chunk = inputs.slice(start, start + ACCEPTANCE_CHUNK);
      const chunkResults = await this.db.transaction(async (tx) => {
        const accepted: AcceptanceRowResult[] = [];
        for (const input of chunk) {
          accepted.push(
            await this.acceptRowInSavepoint(tx, {
              ...input,
              event: { ...input.event, hold: options.hold },
            }),
          );
        }
        return accepted;
      });
      await this.assertPersisted(
        chunkResults
          .filter(
            (result): result is AcceptedRow => result.status === 'accepted',
          )
          .map((result) => result.order.id),
      );
      results.push(...chunkResults);
    }
    return results;
  }

  /** One row inside its own SAVEPOINT, so its rollback is not the chunk's. */
  private async acceptRowInSavepoint(
    tx: Transaction,
    input: ManualOrderAcceptanceInput,
  ): Promise<AcceptanceRowResult> {
    try {
      return await tx.transaction(async (savepoint) => {
        const result = await this.acceptWithinTransaction(savepoint, input);
        if (result.status === 'already_imported') throw new RowRollback();
        return result;
      });
    } catch (error) {
      if (error instanceof RowRollback) return { status: 'already_imported' };
      throw error;
    }
  }

  /**
   * Read the acceptance back on a fresh connection before we report success.
   *
   * A driver that resolves a transaction Postgres later rolled back returns
   * real `RETURNING` ids for rows that do not exist, so every downstream signal
   * -- the 202, the order id, the dispatch -- looks correct while the order is
   * gone. That is not hypothetical: it is the defect this guard was written
   * for. Nothing else on the accept path can observe it, because every other
   * check reads values the doomed transaction produced.
   *
   * One indexed lookup per accepted chunk, and it converts the worst failure
   * mode we have seen (silent data loss reported as success) into a retryable
   * 503.
   */
  private async assertPersisted(orderIds: string[]): Promise<void> {
    if (orderIds.length === 0) return;
    const rows = await this.db
      .select({ id: orders.id })
      .from(orders)
      .where(inArray(orders.id, orderIds));
    const persisted = new Set(rows.map((row) => row.id));
    const missing = orderIds.find((id) => !persisted.has(id));
    if (missing) {
      throw new ManualOrderAcceptanceStateError(
        `The accepted manual order ${missing} was not persisted; the transaction did not commit`,
      );
    }
  }

  /**
   * The whole of one order's acceptance, inside a caller-owned transaction.
   *
   * The single implementation behind both `accept` (one manual order) and
   * `acceptMany` (a chunk of held import rows). The only difference between the
   * two paths is `input.event.hold`, which makes the event undispatchable and
   * turns an identity collision into a reported result instead of a replay.
   *
   * Two identities are checked, in this order: the event key (is this the same
   * request again?) and the order's external identity (is this the same order
   * again, under another key or from another channel?). Both compare the same
   * strict fingerprint, and neither takes a lock: the two unique indexes
   * decide the winner, and under READ COMMITTED the loser's next statement
   * sees the winner's committed rows.
   */
  private async acceptWithinTransaction(
    tx: Transaction,
    input: ManualOrderAcceptanceInput,
  ): Promise<AcceptanceRowResult> {
    const [insertedEvent] = await tx
      .insert(webhookEvents)
      .values({
        platform: 'standalone',
        jobType: 'order.create',
        idempotencyKey: input.event.idempotencyKey,
        storeDomain: input.event.storeDomain,
        orgId: input.event.orgId,
        integrationId: input.event.integrationId,
        rawPayload: input.event.rawPayload,
        status: 'pending',
        ...(input.event.hold
          ? {
              dispatchRequired: false,
              nextDispatchAt: null,
              holdState: 'held',
              holdGroupId: input.event.hold.groupId,
              heldAt: sql`NOW()`,
            }
          : { dispatchRequired: true, nextDispatchAt: sql`NOW()` }),
      })
      .onConflictDoNothing({
        target: [
          webhookEvents.platform,
          webhookEvents.storeDomain,
          webhookEvents.idempotencyKey,
        ],
      })
      .returning();

    if (!insertedEvent) {
      const [existingEvent] = await tx
        .select()
        .from(webhookEvents)
        .where(
          and(
            eq(webhookEvents.platform, 'standalone'),
            eq(webhookEvents.storeDomain, input.event.storeDomain),
            eq(webhookEvents.idempotencyKey, input.event.idempotencyKey),
          ),
        )
        .limit(1);
      if (!existingEvent) {
        throw new ManualOrderAcceptanceStateError(
          'The accepted manual-order event could not be reloaded',
        );
      }
      if (
        existingEvent.orgId !== input.event.orgId ||
        existingEvent.integrationId !== input.event.integrationId
      ) {
        throw new ManualOrderAcceptanceStateError(
          'The accepted manual-order event has different source ownership',
        );
      }
      if (
        this.submissionFingerprint(existingEvent.rawPayload) !==
        input.event.submissionFingerprint
      ) {
        throw new ManualOrderPayloadConflictError();
      }

      const existingOrder = await this.findOrder(tx, input.order);
      if (!existingOrder) {
        throw new ManualOrderAcceptanceStateError(
          'The accepted manual order is missing',
        );
      }
      if (existingEvent.orderId && existingEvent.orderId !== existingOrder.id) {
        throw new ManualOrderAcceptanceStateError(
          'The accepted manual-order event is linked to another order',
        );
      }
      if (!existingEvent.orderId) {
        await tx
          .update(webhookEvents)
          .set({ orderId: existingOrder.id })
          .where(eq(webhookEvents.id, existingEvent.id));
      }
      return {
        status: 'accepted',
        eventId: existingEvent.id,
        order: existingOrder,
        duplicate: true,
        replay: 'event_key',
      };
    }

    const [createdOrder] = await tx
      .insert(orders)
      .values(input.order)
      .onConflictDoNothing({
        target: [orders.integrationId, orders.externalOrderId],
      })
      .returning();
    if (!createdOrder) {
      // Held: another batch or an earlier order already owns this identity.
      // The caller marks the row a duplicate; the savepoint discards the event
      // just inserted, so nothing is left orphaned.
      if (input.event.hold) return { status: 'already_imported' };
      return this.replayExistingIdentity(tx, input);
    }
    await tx
      .update(webhookEvents)
      .set({ orderId: createdOrder.id })
      .where(eq(webhookEvents.id, insertedEvent.id));
    return {
      status: 'accepted',
      eventId: insertedEvent.id,
      order: createdOrder,
      duplicate: false,
    };
  }

  /**
   * A new key for an order identity the source already has. Identical content
   * replays the stored order; anything else is a conflict. Either way this
   * throws, so the transaction rolls back and the event inserted for this
   * request does not survive.
   */
  private async replayExistingIdentity(
    tx: Transaction,
    input: ManualOrderAcceptanceInput,
  ): Promise<never> {
    const existingOrder = await this.findOrder(tx, input.order);
    if (!existingOrder) {
      throw new ManualOrderAcceptanceStateError(
        'The order identity is taken but its order could not be reloaded',
      );
    }
    // An order with no stored fingerprint (redacted, or not created by this
    // repository) cannot be shown to be the same order, so it is a conflict.
    if (
      this.submissionFingerprint(existingOrder.rawPayload) !==
      input.event.submissionFingerprint
    ) {
      throw new ManualOrderIdentityConflictError();
    }
    const [owningEvent] = await tx
      .select({ id: webhookEvents.id })
      .from(webhookEvents)
      .where(
        and(
          eq(webhookEvents.orderId, existingOrder.id),
          eq(webhookEvents.orgId, input.event.orgId),
          eq(webhookEvents.integrationId, input.event.integrationId),
        ),
      )
      .limit(1);
    if (!owningEvent) {
      throw new ManualOrderAcceptanceStateError(
        'The existing order has no acceptance event',
      );
    }
    throw new IdentityReplayRollback({
      eventId: owningEvent.id,
      order: existingOrder,
    });
  }

  private async findOrder(
    tx: Transaction,
    order: typeof orders.$inferInsert,
  ): Promise<typeof orders.$inferSelect | undefined> {
    const [existing] = await tx
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.orgId, order.orgId),
          eq(orders.integrationId, order.integrationId),
          eq(orders.externalOrderId, order.externalOrderId),
        ),
      )
      .limit(1);
    return existing;
  }

  private submissionFingerprint(rawPayload: unknown): string | null {
    if (!rawPayload || typeof rawPayload !== 'object') return null;
    const value = (rawPayload as Record<string, unknown>)[
      'submissionFingerprint'
    ];
    return typeof value === 'string' ? value : null;
  }
}
