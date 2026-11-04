import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database.provider';
import { verificationMessageDispatches as dispatches } from '../schema';

export interface LastAcceptedSender {
  kind: 'akeed_system' | 'merchant_own';
  reason: string | null;
  acceptedAt: string;
  deliveryStatus: 'accepted' | 'delivered' | 'read' | 'failed';
}

@Injectable()
export class WhatsappSenderReadRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  /** Historical observation, never a prediction of the next template's sender. */
  async lastAccepted(orgId: string): Promise<LastAcceptedSender | null> {
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
          sql`${dispatches.kind}::text IN ('initial', 'follow_up')`,
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
