import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../index';
import { DRIZZLE } from '../database.provider';
import { whatsappConnectTickets } from '../schema';

type Database = PostgresJsDatabase<typeof schema>;

export interface IssueWhatsappConnectTicketInput {
  orgId: string;
  userId: string;
  /** SHA-256 hex of the ticket. The ticket itself is never stored. */
  tokenHash: string;
  ttlSeconds: number;
}

export interface ConsumedWhatsappConnectTicket {
  orgId: string;
  userId: string;
}

@Injectable()
export class WhatsappConnectTicketsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Stores a ticket's hash. Expiry is computed by the database, the same clock
   * `consume` compares against.
   */
  async issue(
    input: IssueWhatsappConnectTicketInput,
  ): Promise<{ id: string; expiresAt: string }> {
    if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds <= 0)
      throw new Error('Ticket lifetime must be a positive whole number');
    const [row] = await this.db
      .insert(whatsappConnectTickets)
      .values({
        orgId: input.orgId,
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: sql`now() + make_interval(secs => ${input.ttlSeconds})`,
      })
      .returning({
        id: whatsappConnectTickets.id,
        expiresAt: whatsappConnectTickets.expiresAt,
      });
    return row;
  }

  /**
   * Uses a ticket once. One statement marks it used only while it is unused
   * and unexpired, so two concurrent attempts cannot both succeed. Null for an
   * unknown, used or expired ticket, without saying which.
   */
  async consume(
    tokenHash: string,
  ): Promise<ConsumedWhatsappConnectTicket | null> {
    const [row] = await this.db
      .update(whatsappConnectTickets)
      .set({ usedAt: sql`now()` })
      .where(
        and(
          eq(whatsappConnectTickets.tokenHash, tokenHash),
          isNull(whatsappConnectTickets.usedAt),
          gt(whatsappConnectTickets.expiresAt, sql`now()`),
        ),
      )
      .returning({
        orgId: whatsappConnectTickets.orgId,
        userId: whatsappConnectTickets.userId,
      });
    return row ?? null;
  }
}
