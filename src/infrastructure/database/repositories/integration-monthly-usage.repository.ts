import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../index';
import { DRIZZLE } from '../database.provider';
import { integrationMonthlyUsage } from '../schema';

interface ReserveMonthlyVerificationSlotParams {
  orgId: string;
  integrationId: string;
  periodStart: string;
  includedLimit: number;
}

export interface MonthlyVerificationSlotReservation {
  allowed: boolean;
  consumedCount: number;
  includedLimit: number;
}

@Injectable()
export class IntegrationMonthlyUsageRepository {
  constructor(@Inject(DRIZZLE) private db: PostgresJsDatabase<typeof schema>) {}

  async getOrgUsageTotalsForPeriod(params: {
    orgId: string;
    periodStart: string;
  }): Promise<{ consumedCount: number; includedLimit: number }> {
    const [usage] = await this.db
      .select({
        consumedCount: sql<number>`COALESCE(SUM(${integrationMonthlyUsage.consumedCount}), 0)::int`,
        includedLimit: sql<number>`COALESCE(SUM(${integrationMonthlyUsage.includedLimit}), 0)::int`,
      })
      .from(integrationMonthlyUsage)
      .where(
        and(
          eq(integrationMonthlyUsage.orgId, params.orgId),
          eq(integrationMonthlyUsage.periodStart, params.periodStart),
        ),
      );

    return {
      consumedCount: usage?.consumedCount ?? 0,
      includedLimit: usage?.includedLimit ?? 0,
    };
  }

  async reserveMonthlyVerificationSlot(
    params: ReserveMonthlyVerificationSlotParams,
  ): Promise<MonthlyVerificationSlotReservation> {
    const now = new Date().toISOString();

    return await this.db.transaction(async (tx) => {
      await tx
        .insert(integrationMonthlyUsage)
        .values({
          orgId: params.orgId,
          integrationId: params.integrationId,
          periodStart: params.periodStart,
          includedLimit: params.includedLimit,
          consumedCount: 0,
          blockedCount: 0,
        })
        .onConflictDoNothing();

      const [usageRow] = await tx
        .select({
          consumedCount: integrationMonthlyUsage.consumedCount,
          includedLimit: integrationMonthlyUsage.includedLimit,
        })
        .from(integrationMonthlyUsage)
        .where(
          and(
            eq(integrationMonthlyUsage.integrationId, params.integrationId),
            eq(integrationMonthlyUsage.periodStart, params.periodStart),
          ),
        )
        .for('update');

      if (!usageRow) {
        throw new Error(
          `Missing integration monthly usage row after upsert for integration ${params.integrationId}`,
        );
      }

      if (usageRow.consumedCount >= params.includedLimit) {
        const [blockedRow] = await tx
          .update(integrationMonthlyUsage)
          .set({
            includedLimit: params.includedLimit,
            blockedCount: sql`${integrationMonthlyUsage.blockedCount} + 1`,
            updatedAt: now,
          })
          .where(
            and(
              eq(integrationMonthlyUsage.integrationId, params.integrationId),
              eq(integrationMonthlyUsage.periodStart, params.periodStart),
            ),
          )
          .returning({
            consumedCount: integrationMonthlyUsage.consumedCount,
            includedLimit: integrationMonthlyUsage.includedLimit,
          });

        return {
          allowed: false,
          consumedCount: blockedRow?.consumedCount ?? usageRow.consumedCount,
          includedLimit: blockedRow?.includedLimit ?? params.includedLimit,
        };
      }

      const [updatedRow] = await tx
        .update(integrationMonthlyUsage)
        .set({
          includedLimit: params.includedLimit,
          consumedCount: sql`${integrationMonthlyUsage.consumedCount} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(integrationMonthlyUsage.integrationId, params.integrationId),
            eq(integrationMonthlyUsage.periodStart, params.periodStart),
          ),
        )
        .returning({
          consumedCount: integrationMonthlyUsage.consumedCount,
          includedLimit: integrationMonthlyUsage.includedLimit,
        });

      if (!updatedRow) {
        throw new Error(
          `Failed to consume integration monthly usage slot for integration ${params.integrationId}`,
        );
      }

      return {
        allowed: true,
        consumedCount: updatedRow.consumedCount,
        includedLimit: updatedRow.includedLimit,
      };
    });
  }

  async releaseMonthlyVerificationSlot(params: {
    integrationId: string;
    periodStart: string;
  }): Promise<void> {
    await this.db
      .update(integrationMonthlyUsage)
      .set({
        consumedCount: sql`GREATEST(${integrationMonthlyUsage.consumedCount} - 1, 0)`,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(integrationMonthlyUsage.integrationId, params.integrationId),
          eq(integrationMonthlyUsage.periodStart, params.periodStart),
        ),
      );
  }
}
