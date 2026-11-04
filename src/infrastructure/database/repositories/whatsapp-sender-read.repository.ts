import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database.provider';
import { verificationMessageDispatches as dispatches } from '../schema';

export interface LastAcceptedSender {
  kind: 'akeed_system' | 'merchant_own';
  reason: string | null;
  acceptedAt: string;
  deliveryStatus: 'accepted' | 'delivered' | 'read' | 'failed';
}

/** The latest accepted confirmation and reminder, kept apart. */
export interface LastAcceptedByMessage {
  confirmation: LastAcceptedSender | null;
  reminder: LastAcceptedSender | null;
}

type ChargeableKind = 'initial' | 'follow_up';

@Injectable()
export class WhatsappSenderReadRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  /** Historical observation, never a prediction of the next template's sender. */
  async lastAccepted(orgId: string): Promise<LastAcceptedSender | null> {
    return this.latest(orgId, ['initial', 'follow_up']);
  }

  /**
   * The same observation for confirmations and reminders separately, so a
   * screen can name which message it describes.
   */
  async lastAcceptedByMessage(orgId: string): Promise<LastAcceptedByMessage> {
    const [confirmation, reminder] = await Promise.all([
      this.latest(orgId, ['initial']),
      this.latest(orgId, ['follow_up']),
    ]);
    return { confirmation, reminder };
  }

  private async latest(
    orgId: string,
    kinds: ChargeableKind[],
  ): Promise<LastAcceptedSender | null> {
    const [row] = await this.db
      .select({
        kind: dispatches.senderKind,
        reason: dispatches.senderReason,
        acceptedAt: dispatches.acceptedAt,
        failedAt: dispatches.failedAt,
        readAt: dispatches.readAt,
        deliveredAt: dispatches.deliveredAt,
      })
      .from(dispatches)
      .where(
        and(
          eq(dispatches.orgId, orgId),
          isNotNull(dispatches.acceptedAt),
          inArray(dispatches.kind, kinds),
          sql`coalesce(${dispatches.metadata}->>'billingExempt', 'false') <> 'true'`,
        ),
      )
      .orderBy(desc(dispatches.acceptedAt), desc(dispatches.id))
      .limit(1);
    return row?.acceptedAt
      ? {
          kind: row.kind,
          reason: row.reason,
          acceptedAt: new Date(row.acceptedAt).toISOString(),
          deliveryStatus: row.failedAt
            ? 'failed'
            : row.readAt
              ? 'read'
              : row.deliveredAt
                ? 'delivered'
                : 'accepted',
        }
      : null;
  }
}
