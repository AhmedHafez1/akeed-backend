import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../index';
import { DRIZZLE } from '../database.provider';
import { orders, webhookEvents } from '../schema';

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

export interface ManualOrderAcceptanceInput {
  event: {
    idempotencyKey: string;
    storeDomain: string;
    orgId: string;
    integrationId: string;
    rawPayload: Record<string, unknown>;
    submissionFingerprint: string;
  };
  order: typeof orders.$inferInsert;
}

export interface ManualOrderAcceptanceResult {
  eventId: string;
  order: typeof orders.$inferSelect;
  duplicate: boolean;
}

@Injectable()
export class ManualOrderIngestionRepository {
  constructor(
    @Inject(DRIZZLE)
    private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  async accept(
    input: ManualOrderAcceptanceInput,
  ): Promise<ManualOrderAcceptanceResult> {
    return this.db.transaction(async (tx) => {
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
          dispatchRequired: true,
          nextDispatchAt: new Date().toISOString(),
          status: 'pending',
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
        return {
          eventId: existingEvent.id,
          order: existingOrder,
          duplicate: true,
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
        throw new ManualOrderAcceptanceStateError(
          'The generated manual order identity already exists',
        );
      }
      return {
        eventId: insertedEvent.id,
        order: createdOrder,
        duplicate: false,
      };
    });
  }

  private async findOrder(
    tx: Parameters<Parameters<typeof this.db.transaction>[0]>[0],
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
