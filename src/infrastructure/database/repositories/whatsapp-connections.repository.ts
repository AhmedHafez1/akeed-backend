import { Inject, Injectable } from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../index';
import { DRIZZLE } from '../database.provider';
import {
  whatsappConnections,
  type WhatsappConnectionState,
  type WhatsappSignupPath,
} from '../schema';
import { databaseErrorCode } from '../../../shared/database/serializable-retry';

type Database = PostgresJsDatabase<typeof schema>;

/**
 * A stored connection, credential ciphertext included. Persistence only:
 * responses are built from named safe fields, never from this row.
 */
export type WhatsappConnectionRecord = typeof whatsappConnections.$inferSelect;

/** Every state that holds credentials and the phone number. */
export type WhatsappLiveConnectionState = Exclude<
  WhatsappConnectionState,
  'disconnected'
>;

export interface SaveWhatsappConnectionInput {
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  signupPath: WhatsappSignupPath;
  state: WhatsappLiveConnectionState;
  stateReason?: string | null;
  /** `v1:` ciphertext from the connection credential boundary. */
  businessTokenEncrypted: string;
  registrationPinEncrypted?: string | null;
}

/** The number is already held by another organization's live connection. */
export class WhatsappPhoneNumberInUseError extends Error {
  constructor() {
    super('WhatsApp phone number is connected to another organization');
    this.name = 'WhatsappPhoneNumberInUseError';
  }
}

const LIVE_PHONE_NUMBER_KEY = 'whatsapp_connections_live_phone_number_key';

/** Walks the `cause` chain, because drivers nest the original error. */
export function violatedConstraint(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { constraint_name?: unknown; cause?: unknown };
  return typeof candidate.constraint_name === 'string'
    ? candidate.constraint_name
    : violatedConstraint(candidate.cause);
}

@Injectable()
export class WhatsappConnectionsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async findByOrg(orgId: string): Promise<WhatsappConnectionRecord | null> {
    const [row] = await this.db
      .select()
      .from(whatsappConnections)
      .where(eq(whatsappConnections.orgId, orgId))
      .limit(1);
    return row ?? null;
  }

  /**
   * The live connection that holds a phone number, for routing an inbound
   * event to its organization. A disconnected row never matches.
   */
  async findLiveByPhoneNumberId(
    phoneNumberId: string,
  ): Promise<WhatsappConnectionRecord | null> {
    const [row] = await this.db
      .select()
      .from(whatsappConnections)
      .where(
        and(
          eq(whatsappConnections.phoneNumberId, phoneNumberId),
          ne(whatsappConnections.state, 'disconnected'),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Creates the organization's connection, or replaces its one row on a
   * reconnect. Health and disconnect fields start over.
   *
   * @throws WhatsappPhoneNumberInUseError when another organization's live
   * connection holds the number.
   */
  async saveForOrg(
    orgId: string,
    input: SaveWhatsappConnectionInput,
  ): Promise<WhatsappConnectionRecord> {
    const values = {
      wabaId: input.wabaId,
      phoneNumberId: input.phoneNumberId,
      displayPhoneNumber: input.displayPhoneNumber,
      signupPath: input.signupPath,
      state: input.state,
      stateReason: input.stateReason ?? null,
      businessTokenEncrypted: input.businessTokenEncrypted,
      registrationPinEncrypted: input.registrationPinEncrypted ?? null,
      degradedClass: null,
      degradedSince: null,
      disconnectedAt: null,
    };
    try {
      const [row] = await this.db
        .insert(whatsappConnections)
        .values({ orgId, ...values })
        .onConflictDoUpdate({
          target: whatsappConnections.orgId,
          set: { ...values, updatedAt: sql`now()` },
        })
        .returning();
      return row;
    } catch (error) {
      if (
        databaseErrorCode(error) === '23505' &&
        violatedConstraint(error) === LIVE_PHONE_NUMBER_KEY
      )
        throw new WhatsappPhoneNumberInUseError();
      throw error;
    }
  }

  /**
   * Moves the organization's connection to `disconnected` and clears every
   * credential in the same statement. The ids stay for history and the
   * number is released. Null when the organization has no connection.
   */
  async markDisconnected(
    orgId: string,
    stateReason: string | null,
  ): Promise<WhatsappConnectionRecord | null> {
    const [row] = await this.db
      .update(whatsappConnections)
      .set({
        state: 'disconnected',
        stateReason,
        businessTokenEncrypted: null,
        registrationPinEncrypted: null,
        disconnectedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(whatsappConnections.orgId, orgId))
      .returning();
    return row ?? null;
  }
}
