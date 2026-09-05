import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { resolveEntitlement } from '../../../shared/billing/entitlement';
import type { VerificationStatus } from '../../../shared/interfaces/verification.interface';
import * as schema from '../index';
import { DRIZZLE } from '../database.provider';
import {
  integrationMonthlyUsage,
  integrations,
  verificationMessageDispatches,
  verifications,
} from '../schema';

export type DispatchKind = 'initial' | 'follow_up';
export type DispatchRecord = typeof verificationMessageDispatches.$inferSelect;

export type DispatchClaimResult =
  | { outcome: 'claimed'; dispatch: DispatchRecord }
  | {
      outcome: 'blocked';
      reason: string;
      consumedCount?: number;
      includedLimit?: number;
    }
  | {
      outcome: 'busy' | 'accepted' | 'outcome_unknown';
      dispatch: DispatchRecord;
    };

@Injectable()
export class VerificationMessageDispatchesRepository {
  constructor(
    @Inject(DRIZZLE)
    private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  async claim(params: {
    orgId: string;
    integrationId: string;
    verificationId: string;
    kind: DispatchKind;
    templateName: string;
    languageCode: string;
    leaseUntil: string;
  }): Promise<DispatchClaimResult> {
    const dispatchKey = `${params.verificationId}:${params.kind}:1`;
    const now = new Date().toISOString();

    return this.db.transaction(async (tx) => {
      await tx
        .insert(verificationMessageDispatches)
        .values({
          orgId: params.orgId,
          integrationId: params.integrationId,
          verificationId: params.verificationId,
          dispatchKey,
          kind: params.kind,
          state: 'ready',
          templateName: params.templateName,
          languageCode: params.languageCode,
        })
        .onConflictDoNothing({
          target: verificationMessageDispatches.dispatchKey,
        });

      const [dispatch] = await tx
        .select()
        .from(verificationMessageDispatches)
        .where(eq(verificationMessageDispatches.dispatchKey, dispatchKey))
        .for('update');
      if (
        !dispatch ||
        dispatch.orgId !== params.orgId ||
        dispatch.integrationId !== params.integrationId ||
        dispatch.verificationId !== params.verificationId
      ) {
        throw new Error('Dispatch identity mismatch');
      }
      if (dispatch.state === 'accepted') {
        return { outcome: 'accepted' as const, dispatch };
      }
      if (dispatch.state === 'outcome_unknown') {
        return { outcome: 'outcome_unknown' as const, dispatch };
      }
      if (dispatch.state === 'sending') {
        if (
          !dispatch.leaseUntil ||
          new Date(dispatch.leaseUntil) > new Date()
        ) {
          return { outcome: 'busy' as const, dispatch };
        }
        const [unknown] = await tx
          .update(verificationMessageDispatches)
          .set({
            state: 'outcome_unknown',
            lastErrorCode: 'dispatch_lease_expired',
            leaseUntil: null,
            updatedAt: now,
          })
          .where(eq(verificationMessageDispatches.id, dispatch.id))
          .returning();
        return { outcome: 'outcome_unknown' as const, dispatch: unknown };
      }

      const [source] = await tx
        .select()
        .from(integrations)
        .where(
          and(
            eq(integrations.id, params.integrationId),
            eq(integrations.orgId, params.orgId),
          ),
        )
        .for('update');
      const entitlement = resolveEntitlement(source, {
        id: params.integrationId,
        orgId: params.orgId,
      });
      if (!entitlement.allowed) {
        return {
          outcome: 'blocked' as const,
          reason: entitlement.reason ?? 'billing_not_active',
        };
      }

      if (!dispatch.usageReserved) {
        await tx
          .insert(integrationMonthlyUsage)
          .values({
            orgId: params.orgId,
            integrationId: params.integrationId,
            periodStart: entitlement.periodStart,
            includedLimit: entitlement.includedLimit,
          })
          .onConflictDoNothing();
        const [usage] = await tx
          .select()
          .from(integrationMonthlyUsage)
          .where(
            and(
              eq(integrationMonthlyUsage.integrationId, params.integrationId),
              eq(integrationMonthlyUsage.periodStart, entitlement.periodStart),
            ),
          )
          .for('update');
        if (!usage)
          throw new Error('Usage row missing after reservation upsert');
        if (usage.consumedCount >= entitlement.includedLimit) {
          await tx
            .update(integrationMonthlyUsage)
            .set({
              blockedCount: sql`${integrationMonthlyUsage.blockedCount} + 1`,
              includedLimit: entitlement.includedLimit,
              updatedAt: now,
            })
            .where(eq(integrationMonthlyUsage.id, usage.id));
          return {
            outcome: 'blocked' as const,
            reason: 'plan_limit_reached',
            consumedCount: usage.consumedCount,
            includedLimit: entitlement.includedLimit,
          };
        }
        await tx
          .update(integrationMonthlyUsage)
          .set({
            consumedCount: sql`${integrationMonthlyUsage.consumedCount} + 1`,
            includedLimit: entitlement.includedLimit,
            updatedAt: now,
          })
          .where(eq(integrationMonthlyUsage.id, usage.id));
      }

      const [claimed] = await tx
        .update(verificationMessageDispatches)
        .set({
          state: 'sending',
          templateName: params.templateName,
          languageCode: params.languageCode,
          usagePeriodStart:
            dispatch.usagePeriodStart ?? entitlement.periodStart,
          usageReserved: true,
          attemptCount: sql`${verificationMessageDispatches.attemptCount} + 1`,
          lastErrorCode: null,
          leaseUntil: params.leaseUntil,
          updatedAt: now,
        })
        .where(eq(verificationMessageDispatches.id, dispatch.id))
        .returning();
      return { outcome: 'claimed' as const, dispatch: claimed };
    });
  }

  async markAccepted(params: {
    dispatchId: string;
    providerMessageId: string;
    sentAt: string;
  }): Promise<DispatchRecord | undefined> {
    return this.db.transaction(async (tx) => {
      const [dispatch] = await tx
        .select()
        .from(verificationMessageDispatches)
        .where(eq(verificationMessageDispatches.id, params.dispatchId))
        .for('update');
      if (!dispatch) return undefined;
      if (dispatch.state === 'accepted') return dispatch;
      if (
        dispatch.state !== 'sending' &&
        dispatch.state !== 'outcome_unknown'
      ) {
        return undefined;
      }
      await this.projectAcceptedVerification(tx, dispatch, params);
      const [updated] = await tx
        .update(verificationMessageDispatches)
        .set({
          state: 'accepted',
          providerMessageId: params.providerMessageId,
          acceptedAt: params.sentAt,
          resolvedAt:
            dispatch.state === 'outcome_unknown' ? params.sentAt : null,
          lastErrorCode: null,
          leaseUntil: null,
          updatedAt: params.sentAt,
        })
        .where(eq(verificationMessageDispatches.id, dispatch.id))
        .returning();
      return updated;
    });
  }

  async markOutcomeUnknown(
    dispatchId: string,
    errorCode: string,
  ): Promise<void> {
    await this.db
      .update(verificationMessageDispatches)
      .set({
        state: 'outcome_unknown',
        lastErrorCode: errorCode,
        leaseUntil: null,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(verificationMessageDispatches.id, dispatchId),
          eq(verificationMessageDispatches.state, 'sending'),
        ),
      );
  }

  async findByProviderMessageId(providerMessageId: string) {
    return this.db.query.verificationMessageDispatches.findFirst({
      where: eq(
        verificationMessageDispatches.providerMessageId,
        providerMessageId,
      ),
    });
  }

  async recordProviderStatus(
    dispatchId: string,
    status: 'delivered' | 'read' | 'failed',
    occurredAt: string,
  ): Promise<void> {
    const updates =
      status === 'delivered'
        ? { deliveredAt: occurredAt }
        : status === 'read'
          ? { deliveredAt: occurredAt, readAt: occurredAt }
          : { failedAt: occurredAt };
    await this.db
      .update(verificationMessageDispatches)
      .set({ ...updates, updatedAt: occurredAt })
      .where(eq(verificationMessageDispatches.id, dispatchId));
  }

  async findUnknownById(id: string) {
    return this.db.query.verificationMessageDispatches.findFirst({
      where: and(
        eq(verificationMessageDispatches.id, id),
        eq(verificationMessageDispatches.state, 'outcome_unknown'),
      ),
      with: {
        verification: { with: { order: { with: { integration: true } } } },
      },
    });
  }

  async findById(id: string) {
    return this.db.query.verificationMessageDispatches.findFirst({
      where: eq(verificationMessageDispatches.id, id),
      with: {
        verification: {
          with: { order: { with: { integration: true, webhookEvents: true } } },
        },
      },
    });
  }

  async resolveNotAccepted(id: string): Promise<DispatchRecord | undefined> {
    const now = new Date().toISOString();
    return this.db.transaction(async (tx) => {
      const [dispatch] = await tx
        .select()
        .from(verificationMessageDispatches)
        .where(eq(verificationMessageDispatches.id, id))
        .for('update');
      if (!dispatch) return undefined;
      if (dispatch.state === 'rejected') return dispatch;
      if (dispatch.state !== 'outcome_unknown') return undefined;
      if (dispatch.usageReserved && dispatch.usagePeriodStart) {
        await tx
          .update(integrationMonthlyUsage)
          .set({
            consumedCount: sql`GREATEST(${integrationMonthlyUsage.consumedCount} - 1, 0)`,
            updatedAt: now,
          })
          .where(
            and(
              eq(integrationMonthlyUsage.integrationId, dispatch.integrationId),
              eq(
                integrationMonthlyUsage.periodStart,
                dispatch.usagePeriodStart,
              ),
            ),
          );
      }
      const [updated] = await tx
        .update(verificationMessageDispatches)
        .set({
          state: 'rejected',
          usageReserved: false,
          resolvedAt: now,
          lastErrorCode: 'provider_not_accepted',
          updatedAt: now,
        })
        .where(eq(verificationMessageDispatches.id, id))
        .returning();
      await tx
        .update(verifications)
        .set({
          status: 'failed',
          metadata: sql`COALESCE(${verifications.metadata}, '{}'::jsonb) || ${JSON.stringify({ reason: 'provider_not_accepted', kind: dispatch.kind })}::jsonb`,
          updatedAt: now,
        })
        .where(eq(verifications.id, dispatch.verificationId));
      return updated;
    });
  }

  private async projectAcceptedVerification(
    tx: Parameters<Parameters<typeof this.db.transaction>[0]>[0],
    dispatch: DispatchRecord,
    params: { providerMessageId: string; sentAt: string },
  ): Promise<void> {
    const common = {
      waMessageId: params.providerMessageId,
      updatedAt: params.sentAt,
    };
    if (dispatch.kind === 'follow_up') {
      await tx
        .update(verifications)
        .set({
          ...common,
          followUpSentAt: params.sentAt,
          followUpAttempts: sql`${verifications.followUpAttempts} + 1`,
        })
        .where(eq(verifications.id, dispatch.verificationId));
      return;
    }
    await tx
      .update(verifications)
      .set({
        ...common,
        status: 'sent' as VerificationStatus,
        lastSentAt: params.sentAt,
        attempts: sql`COALESCE(${verifications.attempts}, 0) + 1`,
        metadata: sql`COALESCE(${verifications.metadata}, '{}'::jsonb) - 'reason' - 'kind'`,
      })
      .where(eq(verifications.id, dispatch.verificationId));
  }
}
