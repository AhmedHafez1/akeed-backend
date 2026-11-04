import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { SenderHealthResult } from '../../../shared/ports/sender-recovery.port';
import { and, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../index';
import { DRIZZLE } from '../database.provider';
import {
  whatsappConnections,
  type WhatsappConnectionState,
  type WhatsappSetupStatus,
  type WhatsappSetupStep,
  type WhatsappSignupPath,
} from '../schema';
import {
  databaseErrorCode,
  withSerializableRetry,
} from '../../../shared/database/serializable-retry';

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

export interface SaveSignupConnectionInput {
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  signupPath: WhatsappSignupPath;
  /** `v1:` ciphertext from the connection credential boundary. */
  businessTokenEncrypted: string;
}

/**
 * States a finished signup may replace: an earlier signup that never finished
 * setup, or a released number. A number being set up, live or offboarded is
 * never overwritten by a signup.
 */
export const SIGNUP_REPLACEABLE_STATES = [
  'connecting',
  'disconnected',
] as const satisfies readonly WhatsappConnectionState[];

export type SaveSignupConnectionResult =
  | { saved: true; connection: WhatsappConnectionRecord }
  | { saved: false; reason: 'connection_exists' };

/** The number is already held by another organization's live connection. */
export class WhatsappPhoneNumberInUseError extends Error {
  constructor() {
    super('WhatsApp phone number is connected to another organization');
    this.name = 'WhatsappPhoneNumberInUseError';
  }
}

export class WhatsappAccountInUseError extends Error {
  constructor() {
    super('WhatsApp account is connected to another organization');
    this.name = 'WhatsappAccountInUseError';
  }
}

const LIVE_PHONE_NUMBER_KEY = 'whatsapp_connections_live_phone_number_key';

/** A new signup starts setup over at its first step. */
const SETUP_RESET = {
  setupStatus: 'pending' as const,
  setupStep: 'subscribe' as const,
  setupAttempts: 0,
  setupLeaseUntil: null,
  setupNextAttemptAt: sql`now()`,
  setupErrorCode: null,
  subscribedAt: null,
  numberVerifiedAt: null,
  registeredAt: null,
  setupCompletedAt: null,
  providerIsOnBizApp: null,
  providerPlatformType: null,
};

/** Only a connection still being set up is worked on by setup. */
const SETUP_STATE: WhatsappConnectionState = 'connecting';

/** States whose templates are kept in step with the merchant's account. */
export const TEMPLATE_SYNC_STATES = [
  'connecting',
  'verifying',
  'active',
] as const satisfies readonly WhatsappConnectionState[];

/** A claimed attempt: the row, the signup it belongs to, and its attempt. */
export type SetupClaim = Pick<
  WhatsappConnectionRecord,
  'id' | 'signupGeneration' | 'setupAttempts'
>;

/** A due setup, as the sweep hands it to a job. */
export interface DueSetup {
  id: string;
  signupGeneration: number;
}

/** What a setup step records on success. Each field is written only if set. */
export interface SetupProgressPatch {
  setupStep?: WhatsappSetupStep;
  subscribedAt?: 'now';
  numberVerifiedAt?: 'now';
  registeredAt?: 'now';
  providerIsOnBizApp?: boolean | null;
  providerPlatformType?: string | null;
}

/** How an attempt that did not finish setup leaves the row. */
export interface SetupRelease {
  status: Extract<WhatsappSetupStatus, 'pending' | 'failed' | 'exhausted'>;
  errorCode: string | null;
  /** When the sweep may pick it up again; null for `exhausted`. */
  nextAttemptAt: Date | null;
}

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

  private async withWabaLock<T>(
    wabaId: string,
    work: (
      tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    ) => Promise<T>,
  ): Promise<T> {
    return withSerializableRetry(() =>
      this.db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${wabaId}, 901))`,
        );
        await tx
          .update(whatsappConnections)
          .set({ disconnectCleanupUntil: null })
          .where(
            and(
              eq(whatsappConnections.wabaId, wabaId),
              eq(whatsappConnections.state, 'disconnected'),
              sql`${whatsappConnections.disconnectCleanupUntil} <= now()`,
            ),
          );
        return work(tx);
      }),
    );
  }

  async applyLifecycle(input: {
    orgId: string;
    connectionId: string;
    generation: number;
    occurredAt: string;
    eventKey: string;
    event: string;
    reason: string;
  }) {
    const disconnect = [
      'PARTNER_REMOVED',
      'PARTNER_APP_UNINSTALLED',
      'ACCOUNT_DELETED',
    ].includes(input.event);
    const offboard = input.event === 'ACCOUNT_OFFBOARDED';
    const reconnect = input.event === 'ACCOUNT_RECONNECTED';
    const [row] = await this.db
      .update(whatsappConnections)
      .set({
        state: disconnect
          ? 'disconnected'
          : offboard
            ? 'offboarded'
            : reconnect
              ? 'verifying'
              : undefined,
        stateReason: input.reason,
        ...(disconnect
          ? {
              businessTokenEncrypted: null,
              registrationPinEncrypted: null,
              disconnectedAt: sql`now()`,
            }
          : {}),
        ...(!disconnect && !offboard && !reconnect
          ? {
              degradedClass: sql`CASE WHEN ${whatsappConnections.degradedClass} = 'credentials' THEN 'credentials' ELSE 'restricted' END`,
              degradedSince: sql`COALESCE(${whatsappConnections.degradedSince}, now())`,
            }
          : {}),
        lifecycleEventAt: input.occurredAt,
        lifecycleEventKey: input.eventKey,
        healthRevision: sql`${whatsappConnections.healthRevision} + 1`,
        healthClaimToken: null,
        healthLeaseUntil: null,
        nextHealthAt: sql`now()`,
        setupLeaseUntil: null,
        // Invalidate any running setup claim without inventing a new signup.
        setupAttempts: sql`${whatsappConnections.setupAttempts} + 1`,
        setupStatus: sql`CASE WHEN ${whatsappConnections.setupStatus} = 'running' THEN 'failed' ELSE ${whatsappConnections.setupStatus} END`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(whatsappConnections.orgId, input.orgId),
          eq(whatsappConnections.id, input.connectionId),
          eq(whatsappConnections.signupGeneration, input.generation),
          ne(whatsappConnections.state, 'disconnected'),
          sql`${whatsappConnections.lifecycleEventKey} IS DISTINCT FROM ${input.eventKey}`,
          sql`${input.occurredAt}::timestamptz >= COALESCE(${whatsappConnections.connectedAt}, ${whatsappConnections.createdAt})`,
          sql`(${whatsappConnections.lifecycleEventAt} IS NULL OR ${whatsappConnections.lifecycleEventAt} < ${input.occurredAt}::timestamptz OR (${whatsappConnections.lifecycleEventAt} = ${input.occurredAt}::timestamptz AND ${whatsappConnections.lifecycleEventKey} <> ${input.eventKey} AND ${disconnect}))`,
        ),
      )
      .returning();
    return row ?? null;
  }

  async requestHealth(orgId: string, id: string, generation: number) {
    await this.db
      .update(whatsappConnections)
      .set({
        nextHealthAt: sql`now()`,
        healthRevision: sql`${whatsappConnections.healthRevision} + 1`,
        healthLeaseUntil: null,
        healthClaimToken: null,
      })
      .where(
        and(
          eq(whatsappConnections.orgId, orgId),
          eq(whatsappConnections.id, id),
          eq(whatsappConnections.signupGeneration, generation),
          inArray(whatsappConnections.state, ['active', 'verifying']),
        ),
      );
  }

  /** Returns the old credential snapshot only to the disconnect service. */
  async beginDisconnect(
    orgId: string,
  ): Promise<WhatsappConnectionRecord | null> {
    return withSerializableRetry(() =>
      this.db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(whatsappConnections)
          .where(eq(whatsappConnections.orgId, orgId))
          .for('update');
        if (!row || row.state === 'disconnected') return null;
        await tx
          .update(whatsappConnections)
          .set({
            state: 'disconnected',
            stateReason: 'merchant_disconnect',
            businessTokenEncrypted: null,
            registrationPinEncrypted: null,
            disconnectedAt: sql`now()`,
            disconnectCleanupUntil: sql`now() + interval '1 minute'`,
            providerCleanup: 'manual_required',
            healthRevision: sql`${whatsappConnections.healthRevision} + 1`,
            healthClaimToken: null,
            healthLeaseUntil: null,
            setupAttempts: sql`${whatsappConnections.setupAttempts} + 1`,
            setupLeaseUntil: null,
            setupStatus: sql`CASE WHEN ${whatsappConnections.setupStatus} = 'running' THEN 'failed' ELSE ${whatsappConnections.setupStatus} END`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(whatsappConnections.id, row.id),
              eq(whatsappConnections.orgId, orgId),
            ),
          );
        return row;
      }),
    );
  }

  async finishDisconnect(
    orgId: string,
    id: string,
    generation: number,
    cleanup: 'succeeded' | 'manual_required',
  ) {
    await this.db
      .update(whatsappConnections)
      .set({
        disconnectCleanupUntil: null,
        providerCleanup: cleanup,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(whatsappConnections.orgId, orgId),
          eq(whatsappConnections.id, id),
          eq(whatsappConnections.signupGeneration, generation),
          eq(whatsappConnections.state, 'disconnected'),
        ),
      );
  }

  async findDueHealth(limit = 50) {
    return this.db
      .select({
        id: whatsappConnections.id,
        orgId: whatsappConnections.orgId,
        signupGeneration: whatsappConnections.signupGeneration,
        nextHealthAt: whatsappConnections.nextHealthAt,
      })
      .from(whatsappConnections)
      .where(
        and(
          inArray(whatsappConnections.state, ['verifying', 'active']),
          sql`${whatsappConnections.nextHealthAt} <= now()`,
          sql`(${whatsappConnections.healthLeaseUntil} IS NULL OR ${whatsappConnections.healthLeaseUntil} < now())`,
        ),
      )
      .orderBy(whatsappConnections.nextHealthAt)
      .limit(limit);
  }

  async claimHealth(orgId: string, id: string, generation: number) {
    const [row] = await this.db
      .update(whatsappConnections)
      .set({
        healthClaimToken: randomUUID(),
        healthLeaseUntil: sql`now() + interval '1 minute'`,
      })
      .where(
        and(
          eq(whatsappConnections.id, id),
          eq(whatsappConnections.orgId, orgId),
          eq(whatsappConnections.signupGeneration, generation),
          inArray(whatsappConnections.state, ['verifying', 'active']),
          sql`${whatsappConnections.nextHealthAt} <= now()`,
          sql`(${whatsappConnections.healthLeaseUntil} IS NULL OR ${whatsappConnections.healthLeaseUntil} < now())`,
        ),
      )
      .returning();
    return row ?? null;
  }

  async completeHealth(
    claim: WhatsappConnectionRecord,
    result: SenderHealthResult,
  ) {
    let degraded = claim.degradedClass;
    if (result.status === 'BLOCKED')
      degraded =
        degraded === 'credentials'
          ? degraded
          : (result.failure?.degrade ?? 'restricted');
    if (result.status === 'AVAILABLE' && degraded !== 'credentials')
      degraded = null;
    const active =
      claim.state === 'verifying' && result.status === 'AVAILABLE' && !degraded;
    const [row] = await this.db
      .update(whatsappConnections)
      .set({
        ...(active ? { state: 'active' as const, stateReason: null } : {}),
        degradedClass: degraded,
        degradedSince: degraded ? (claim.degradedSince ?? sql`now()`) : null,
        ...(result.status !== 'unknown'
          ? {
              qualityRating: result.qualityRating ?? claim.qualityRating,
              nameStatus: result.nameStatus ?? claim.nameStatus,
            }
          : {}),
        lastHealthAt: sql`now()`,
        nextHealthAt: sql`now() + ${degraded ? 15 : 360} * interval '1 minute'`,
        healthLeaseUntil: null,
        healthClaimToken: null,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(whatsappConnections.id, claim.id),
          eq(whatsappConnections.orgId, claim.orgId),
          eq(whatsappConnections.signupGeneration, claim.signupGeneration),
          eq(whatsappConnections.healthRevision, claim.healthRevision),
          eq(whatsappConnections.healthClaimToken, claim.healthClaimToken!),
          sql`${whatsappConnections.healthLeaseUntil} > now()`,
          inArray(whatsappConnections.state, ['verifying', 'active']),
        ),
      )
      .returning();
    return row ?? null;
  }

  async findByOrg(orgId: string): Promise<WhatsappConnectionRecord | null> {
    const [row] = await this.db
      .select()
      .from(whatsappConnections)
      .where(eq(whatsappConnections.orgId, orgId))
      .limit(1);
    return row ?? null;
  }

  async updateThankYouEnabled(
    orgId: string,
    thankYouEnabled: boolean,
  ): Promise<{ thankYouEnabled: boolean } | null> {
    const [row] = await this.db
      .update(whatsappConnections)
      .set({ thankYouEnabled, updatedAt: sql`now()` })
      .where(eq(whatsappConnections.orgId, orgId))
      .returning({ thankYouEnabled: whatsappConnections.thankYouEnabled });
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
      healthRevision: 0,
      healthClaimToken: null,
      healthLeaseUntil: null,
      nextHealthAt: sql`now()`,
      disconnectedAt: null,
    };
    try {
      const [row] = await this.withWabaLock(input.wabaId, (tx) =>
        tx
          .insert(whatsappConnections)
          .values({ orgId, ...values })
          .onConflictDoUpdate({
            target: whatsappConnections.orgId,
            set: {
              ...values,
              healthRevision: sql`${whatsappConnections.healthRevision} + 1`,
              updatedAt: sql`now()`,
            },
          })
          .returning(),
      );
      return row;
    } catch (error) {
      if (
        databaseErrorCode(error) === '23505' &&
        violatedConstraint(error) === 'whatsapp_connections_live_waba_key'
      )
        throw new WhatsappAccountInUseError();
      if (
        databaseErrorCode(error) === '23505' &&
        violatedConstraint(error) === LIVE_PHONE_NUMBER_KEY
      )
        throw new WhatsappPhoneNumberInUseError();
      throw error;
    }
  }

  /**
   * Stores a verified signup as the organization's connection in state
   * `connecting`. One statement inserts the row or replaces it only while it
   * is in a {@link SIGNUP_REPLACEABLE_STATES} state, so two concurrent
   * signups cannot overwrite a connection that moved on in between.
   *
   * @throws WhatsappPhoneNumberInUseError when another organization's live
   * connection holds the number.
   */
  async saveSignupForOrg(
    orgId: string,
    input: SaveSignupConnectionInput,
  ): Promise<SaveSignupConnectionResult> {
    const values = {
      wabaId: input.wabaId,
      phoneNumberId: input.phoneNumberId,
      displayPhoneNumber: input.displayPhoneNumber,
      signupPath: input.signupPath,
      state: 'connecting' as const,
      stateReason: null,
      businessTokenEncrypted: input.businessTokenEncrypted,
      registrationPinEncrypted: null,
      degradedClass: null,
      degradedSince: null,
      healthClaimToken: null,
      healthLeaseUntil: null,
      nextHealthAt: sql`now()`,
      qualityRating: null,
      nameStatus: null,
      lastHealthAt: null,
      connectedAt: sql`now()`,
      disconnectedAt: null,
      lifecycleEventAt: null,
      lifecycleEventKey: null,
      disconnectCleanupUntil: null,
      providerCleanup: null,
      ...SETUP_RESET,
    };
    try {
      const [row] = await this.withWabaLock(input.wabaId, (tx) =>
        tx
          .insert(whatsappConnections)
          .values({ orgId, ...values })
          .onConflictDoUpdate({
            target: whatsappConnections.orgId,
            set: {
              ...values,
              // The row keeps its id, so a job queued for the replaced signup
              // is told apart by its generation.
              signupGeneration: sql`${whatsappConnections.signupGeneration} + 1`,
              healthRevision: sql`${whatsappConnections.healthRevision} + 1`,
              updatedAt: sql`now()`,
            },
            setWhere: and(
              sql`(${whatsappConnections.disconnectCleanupUntil} IS NULL OR ${whatsappConnections.disconnectCleanupUntil} <= now())`,
              inArray(whatsappConnections.state, [
                ...SIGNUP_REPLACEABLE_STATES,
              ]),
            ),
          })
          .returning(),
      );
      return row
        ? { saved: true, connection: row }
        : { saved: false, reason: 'connection_exists' };
    } catch (error) {
      if (
        databaseErrorCode(error) === '23505' &&
        violatedConstraint(error) === 'whatsapp_connections_live_waba_key'
      )
        throw new WhatsappAccountInUseError();
      if (
        databaseErrorCode(error) === '23505' &&
        violatedConstraint(error) === LIVE_PHONE_NUMBER_KEY
      )
        throw new WhatsappPhoneNumberInUseError();
      throw error;
    }
  }

  async findById(id: string): Promise<WhatsappConnectionRecord | null> {
    const [row] = await this.db
      .select()
      .from(whatsappConnections)
      .where(eq(whatsappConnections.id, id))
      .limit(1);
    return row ?? null;
  }

  /**
   * The live connection of a WhatsApp Business Account, for routing an
   * account-level event. A disconnected row never matches.
   */
  async findLiveByWabaId(
    wabaId: string,
  ): Promise<WhatsappConnectionRecord | null> {
    const [row] = await this.db
      .select()
      .from(whatsappConnections)
      .where(
        and(
          eq(whatsappConnections.wabaId, wabaId),
          ne(whatsappConnections.state, 'disconnected'),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Setups a worker may take now: waiting and due, or running with an expired
   * lease. Read only; the job claims the row itself, so listing one twice is
   * harmless.
   */
  async findDueSetups(limit: number): Promise<DueSetup[]> {
    return this.db
      .select({
        id: whatsappConnections.id,
        signupGeneration: whatsappConnections.signupGeneration,
      })
      .from(whatsappConnections)
      .where(
        and(
          eq(whatsappConnections.state, SETUP_STATE),
          sql`(
            (${whatsappConnections.setupStatus} IN ('pending', 'failed')
              AND ${whatsappConnections.setupNextAttemptAt} <= now())
            OR (${whatsappConnections.setupStatus} = 'running'
              AND ${whatsappConnections.setupLeaseUntil} < now())
          )`,
        ),
      )
      .orderBy(whatsappConnections.setupNextAttemptAt)
      .limit(limit);
  }

  /**
   * Takes a setup for one attempt. One statement checks the generation, the
   * state and that the setup is due or its lease ran out, so of two workers
   * only one gets the row. Null when there is nothing to do.
   */
  async claimSetup(
    id: string,
    generation: number,
    leaseMs: number,
  ): Promise<WhatsappConnectionRecord | null> {
    const [row] = await this.db
      .update(whatsappConnections)
      .set({
        setupStatus: 'running',
        setupLeaseUntil: sql`now() + ${leaseMs} * interval '1 millisecond'`,
        setupAttempts: sql`${whatsappConnections.setupAttempts} + 1`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(whatsappConnections.id, id),
          eq(whatsappConnections.signupGeneration, generation),
          eq(whatsappConnections.state, SETUP_STATE),
          sql`(
            (${whatsappConnections.setupStatus} IN ('pending', 'failed')
              AND ${whatsappConnections.setupNextAttemptAt} <= now())
            OR (${whatsappConnections.setupStatus} = 'running'
              AND ${whatsappConnections.setupLeaseUntil} < now())
          )`,
        ),
      )
      .returning();
    return row ?? null;
  }

  /**
   * Records a finished step under the claim. Null when the claim was lost: a
   * newer signup, a disconnect, or another worker after the lease ran out.
   */
  async recordSetupProgress(
    claim: SetupClaim,
    patch: SetupProgressPatch,
  ): Promise<WhatsappConnectionRecord | null> {
    const [row] = await this.db
      .update(whatsappConnections)
      .set({
        ...(patch.setupStep !== undefined && { setupStep: patch.setupStep }),
        ...(patch.subscribedAt && { subscribedAt: sql`now()` }),
        ...(patch.numberVerifiedAt && { numberVerifiedAt: sql`now()` }),
        ...(patch.registeredAt && { registeredAt: sql`now()` }),
        ...(patch.providerIsOnBizApp !== undefined && {
          providerIsOnBizApp: patch.providerIsOnBizApp,
        }),
        ...(patch.providerPlatformType !== undefined && {
          providerPlatformType: patch.providerPlatformType,
        }),
        setupErrorCode: null,
        updatedAt: sql`now()`,
      })
      .where(this.heldClaim(claim))
      .returning();
    return row ?? null;
  }

  /**
   * Stores the registration PIN once. A PIN already stored is kept, so every
   * retry registers with the same one. Returns the row as stored, or null when
   * the claim was lost.
   */
  async storeRegistrationPinOnce(
    claim: SetupClaim,
    pinEncrypted: string,
  ): Promise<WhatsappConnectionRecord | null> {
    const [row] = await this.db
      .update(whatsappConnections)
      .set({
        registrationPinEncrypted: sql`COALESCE(${whatsappConnections.registrationPinEncrypted}, ${pinEncrypted})`,
        updatedAt: sql`now()`,
      })
      .where(this.heldClaim(claim))
      .returning();
    return row ?? null;
  }

  /** Ends an attempt that did not finish setup, and drops the claim. */
  async releaseSetup(
    claim: SetupClaim,
    release: SetupRelease,
  ): Promise<WhatsappConnectionRecord | null> {
    const [row] = await this.db
      .update(whatsappConnections)
      .set({
        setupStatus: release.status,
        setupErrorCode: release.errorCode,
        setupNextAttemptAt: release.nextAttemptAt
          ? release.nextAttemptAt.toISOString()
          : null,
        setupLeaseUntil: null,
        // A pending release is progress, not a failed try.
        ...(release.status === 'pending' && { setupAttempts: 0 }),
        updatedAt: sql`now()`,
      })
      .where(this.heldClaim(claim))
      .returning();
    return row ?? null;
  }

  /**
   * Setup is done: the connection moves to `verifying`, where the health check
   * decides when it may send. Nothing here marks a number ready.
   */
  async completeSetup(
    claim: SetupClaim,
  ): Promise<WhatsappConnectionRecord | null> {
    const [row] = await this.db
      .update(whatsappConnections)
      .set({
        state: 'verifying',
        setupStatus: 'complete',
        setupStep: 'done',
        setupErrorCode: null,
        setupLeaseUntil: null,
        setupNextAttemptAt: null,
        setupCompletedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(this.heldClaim(claim))
      .returning();
    return row ?? null;
  }

  /**
   * Connections whose templates are kept in step with their account: live,
   * and set up at least as far as a confirmed number.
   */
  async findForTemplateSync(): Promise<DueSetup[]> {
    return this.db
      .select({
        id: whatsappConnections.id,
        signupGeneration: whatsappConnections.signupGeneration,
      })
      .from(whatsappConnections)
      .where(
        and(
          inArray(whatsappConnections.state, [...TEMPLATE_SYNC_STATES]),
          isNotNull(whatsappConnections.numberVerifiedAt),
        ),
      )
      .orderBy(whatsappConnections.id);
  }

  private heldClaim(claim: SetupClaim) {
    return and(
      eq(whatsappConnections.id, claim.id),
      eq(whatsappConnections.signupGeneration, claim.signupGeneration),
      // The attempt number is the claim token: a worker whose lease ran out
      // and was taken over can no longer write.
      eq(whatsappConnections.setupAttempts, claim.setupAttempts),
      eq(whatsappConnections.state, SETUP_STATE),
      eq(whatsappConnections.setupStatus, 'running'),
    );
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
        healthRevision: sql`${whatsappConnections.healthRevision} + 1`,
        healthClaimToken: null,
        healthLeaseUntil: null,
        updatedAt: sql`now()`,
      })
      .where(eq(whatsappConnections.orgId, orgId))
      .returning();
    return row ?? null;
  }
}
