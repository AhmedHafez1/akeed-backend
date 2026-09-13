import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  notExists,
  or,
  sql,
} from 'drizzle-orm';
import {
  DRIZZLE,
  type DrizzleDB,
} from '../../infrastructure/database/database.provider';
import {
  billingReconciliationAttempts,
  billingReconciliationFindings,
  billingReconciliationRuns,
  billingSettlementReports,
  creditAccounts,
  creditLedgerEntries,
  paymentProviderEvents,
  paymentPurchases,
} from '../../infrastructure/database/schema';
import type {
  BillingFindingInput,
  BillingFindingSeverity,
  BillingFindingStatus,
  BillingRunMode,
  BillingRunTrigger,
  SettlementInput,
} from './billing-observability.types';

export interface ReconciliationCandidate extends Record<string, unknown> {
  id: string;
  orgId: string;
  reference: string;
  provider: string;
  mode: string;
  quantity: number;
  unitPriceMinor: number;
  totalMinor: number;
  currency: string;
  status: string;
  disputeStatus: string;
  providerIntentionId: string | null;
  providerOrderId: string | null;
  providerTransactionId: string | null;
  checkoutExpiresAt: string | null;
  refundedMinor: number;
  reconciliationRequired: boolean;
  updatedAt: string;
  createdAt: string;
}

@Injectable()
export class BillingObservabilityRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async createRun(input: {
    runKey: string;
    trigger: BillingRunTrigger;
    mode: BillingRunMode;
    settlementId?: string;
    triggeredBy?: string;
    reason?: string;
  }) {
    await this.db
      .insert(billingReconciliationRuns)
      .values(input)
      .onConflictDoNothing({ target: billingReconciliationRuns.runKey });
    const [row] = await this.db
      .select()
      .from(billingReconciliationRuns)
      .where(eq(billingReconciliationRuns.runKey, input.runKey));
    return row;
  }

  /**
   * A run is claimable until it completes. `running` is included because the
   * run is 1:1 with its BullMQ job id: a redelivery of a `running` run means
   * the worker holding it stalled or died, and the completed-attempt markers
   * make continuing it safe.
   */
  async claimRun(runId: string): Promise<boolean> {
    const rows = await this.db
      .update(billingReconciliationRuns)
      .set({
        status: 'running',
        startedAt: new Date().toISOString(),
        completedAt: null,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(billingReconciliationRuns.id, runId),
          inArray(billingReconciliationRuns.status, [
            'queued',
            'running',
            'failed',
          ]),
        ),
      )
      .returning({ id: billingReconciliationRuns.id });
    return rows.length === 1;
  }

  async finishRun(
    runId: string,
    status: 'completed' | 'failed',
    counts: {
      candidates: number;
      attempted: number;
      resolved: number;
      deferred: number;
      findingsOpened: number;
      findingsResolved: number;
    },
  ): Promise<void> {
    await this.db
      .update(billingReconciliationRuns)
      .set({
        ...counts,
        status,
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(billingReconciliationRuns.id, runId));
  }

  async latestRun() {
    const [row] = await this.db
      .select()
      .from(billingReconciliationRuns)
      .orderBy(desc(billingReconciliationRuns.createdAt))
      .limit(1);
    return row;
  }

  async run(runId: string) {
    const [row] = await this.db
      .select()
      .from(billingReconciliationRuns)
      .where(eq(billingReconciliationRuns.id, runId));
    return row;
  }

  async recordAttempt(input: {
    runId: string;
    orgId?: string;
    purchaseId?: string;
    targetKind: string;
    targetKey: string;
    outcome: string;
    errorCode?: string;
    durationMs: number;
  }): Promise<boolean> {
    const rows = await this.db
      .insert(billingReconciliationAttempts)
      .values(input)
      .onConflictDoNothing({
        target: [
          billingReconciliationAttempts.runId,
          billingReconciliationAttempts.targetKind,
          billingReconciliationAttempts.targetKey,
        ],
      })
      .returning({ id: billingReconciliationAttempts.id });
    return rows.length === 1;
  }

  async hasAttempt(
    runId: string,
    targetKind: string,
    targetKey: string,
  ): Promise<boolean> {
    const [row] = await this.db
      .select({ id: billingReconciliationAttempts.id })
      .from(billingReconciliationAttempts)
      .where(
        and(
          eq(billingReconciliationAttempts.runId, runId),
          eq(billingReconciliationAttempts.targetKind, targetKind),
          eq(billingReconciliationAttempts.targetKey, targetKey),
        ),
      )
      .limit(1);
    return !!row;
  }

  async candidates(input: {
    staleBefore: string;
    lookbackSince: string;
    limit: number;
    cursor?: { createdAt: string; id: string };
  }): Promise<ReconciliationCandidate[]> {
    const cursor = input.cursor
      ? sql`AND (purchase.created_at, purchase.id) > (${input.cursor.createdAt}::timestamptz, ${input.cursor.id}::uuid)`
      : sql``;
    const rows = await this.db.execute<ReconciliationCandidate>(sql`
      SELECT
        purchase.id,
        purchase.org_id AS "orgId",
        purchase.reference,
        purchase.provider,
        purchase.mode,
        purchase.quantity,
        purchase.unit_price_minor AS "unitPriceMinor",
        purchase.total_minor AS "totalMinor",
        purchase.currency,
        purchase.status,
        purchase.dispute_status AS "disputeStatus",
        purchase.provider_intention_id AS "providerIntentionId",
        purchase.provider_order_id AS "providerOrderId",
        purchase.provider_transaction_id AS "providerTransactionId",
        purchase.checkout_expires_at AS "checkoutExpiresAt",
        purchase.refunded_minor AS "refundedMinor",
        purchase.reconciliation_required AS "reconciliationRequired",
        purchase.updated_at AS "updatedAt",
        purchase.created_at AS "createdAt"
      FROM ${paymentPurchases} purchase
      WHERE (
        purchase.reconciliation_required
        OR (
          purchase.status = 'pending'
          AND purchase.checkout_expires_at IS NOT NULL
          AND purchase.checkout_expires_at <= ${input.staleBefore}::timestamptz
        )
        OR (
          (purchase.status IN ('successful', 'refunded') OR purchase.dispute_status <> 'none')
          AND purchase.updated_at >= ${input.lookbackSince}::timestamptz
        )
      )
      AND (
        purchase.next_reconciliation_at IS NULL
        OR purchase.next_reconciliation_at <= now()
      )
      ${cursor}
      ORDER BY purchase.created_at, purchase.id
      LIMIT ${input.limit}
    `);
    return [...rows];
  }

  async organizationIds(input: {
    limit: number;
    cursor?: string;
  }): Promise<string[]> {
    const rows = await this.db
      .select({ orgId: creditAccounts.orgId })
      .from(creditAccounts)
      .where(input.cursor ? lt(creditAccounts.orgId, input.cursor) : undefined)
      .orderBy(desc(creditAccounts.orgId))
      .limit(input.limit);
    return rows.map((row) => row.orgId);
  }

  async staticSignals() {
    const rows = await this.db.execute<{
      code: string;
      severity: BillingFindingSeverity;
      nextAction: string;
      orgId: string | null;
      purchaseId: string | null;
      identity: string;
      errorCode: string | null;
    }>(sql`
      SELECT
        'trusted_data_mismatch' AS code,
        'critical' AS severity,
        'review_purchase' AS "nextAction",
        event.org_id AS "orgId",
        event.purchase_id AS "purchaseId",
        event.id::text AS identity,
        event.error_code AS "errorCode"
      FROM ${paymentProviderEvents} event
      WHERE event.error_code IN (
        'amount_mismatch', 'currency_mismatch', 'integration_mismatch',
        'mode_mismatch', 'ownership_mismatch', 'unmatched_reference'
      )
      UNION ALL
      SELECT
        'duplicate_provider_id', 'critical', 'investigate_sources',
        -- Both references come from the same (earliest) event so the pair
        -- satisfies the tenant-safe purchase foreign key.
        (array_agg(event.org_id ORDER BY event.received_at, event.id))[1],
        (array_agg(event.purchase_id ORDER BY event.received_at, event.id))[1],
        coalesce(event.provider_transaction_id, event.provider_order_id, event.provider_intention_id),
        null
      FROM ${paymentProviderEvents} event
      WHERE event.purchase_id IS NOT NULL
        AND coalesce(event.provider_transaction_id, event.provider_order_id, event.provider_intention_id) IS NOT NULL
      GROUP BY event.provider, coalesce(event.provider_transaction_id, event.provider_order_id, event.provider_intention_id)
      HAVING count(DISTINCT event.purchase_id) > 1
      UNION ALL
      SELECT
        'credit_debt', 'attention', 'resolve_debt',
        account.org_id, null, account.org_id::text, null
      FROM ${creditAccounts} account
      WHERE account.posted_balance < 0
      UNION ALL
      SELECT
        CASE WHEN purchase.dispute_status <> 'none' THEN 'chargeback_state' ELSE 'refund_state' END,
        'attention', 'review_refund_dispute',
        purchase.org_id, purchase.id, purchase.reference, null
      FROM ${paymentPurchases} purchase
      WHERE purchase.refunded_minor > 0 OR purchase.dispute_status <> 'none'
    `);
    return [...rows];
  }

  async finding(fingerprint: string) {
    const [row] = await this.db
      .select({
        status: billingReconciliationFindings.status,
        retryCount: billingReconciliationFindings.retryCount,
        nextAttemptAt: billingReconciliationFindings.nextAttemptAt,
      })
      .from(billingReconciliationFindings)
      .where(eq(billingReconciliationFindings.fingerprint, fingerprint));
    return row;
  }

  async upsertFinding(
    runId: string,
    finding: BillingFindingInput,
  ): Promise<'opened' | 'updated'> {
    const existing = await this.db
      .select({ status: billingReconciliationFindings.status })
      .from(billingReconciliationFindings)
      .where(eq(billingReconciliationFindings.fingerprint, finding.fingerprint))
      .limit(1);
    const now = new Date().toISOString();
    await this.db
      .insert(billingReconciliationFindings)
      .values({
        ...finding,
        lastRunId: runId,
        safeContext: finding.safeContext ?? {},
      })
      .onConflictDoUpdate({
        target: billingReconciliationFindings.fingerprint,
        set: {
          code: finding.code,
          severity: finding.severity,
          status: 'open',
          orgId: finding.orgId,
          purchaseId: finding.purchaseId,
          settlementId: finding.settlementId,
          retryCount: finding.retryCount ?? 0,
          nextAction: finding.nextAction,
          nextAttemptAt: finding.nextAttemptAt,
          safeContext: finding.safeContext ?? {},
          lastRunId: runId,
          lastSeenAt: now,
          resolvedAt: null,
          updatedAt: now,
          occurrenceCount: sql`${billingReconciliationFindings.occurrenceCount} + 1`,
        },
      });
    return existing.length === 0 || existing[0].status === 'resolved'
      ? 'opened'
      : 'updated';
  }

  /** Marks a purchase's open findings as seen by `runId` without re-asking. */
  async carryPurchaseFindings(
    runId: string,
    purchaseId: string,
  ): Promise<void> {
    await this.db
      .update(billingReconciliationFindings)
      .set({ lastRunId: runId, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(billingReconciliationFindings.purchaseId, purchaseId),
          eq(billingReconciliationFindings.status, 'open'),
        ),
      );
  }

  async resolveUnseen(runId: string, codes: string[]): Promise<number> {
    if (!codes.length) return 0;
    const now = new Date().toISOString();
    const rows = await this.db
      .update(billingReconciliationFindings)
      .set({ status: 'resolved', resolvedAt: now, updatedAt: now })
      .where(
        and(
          eq(billingReconciliationFindings.status, 'open'),
          inArray(billingReconciliationFindings.code, codes),
          or(
            isNull(billingReconciliationFindings.lastRunId),
            sql`${billingReconciliationFindings.lastRunId} <> ${runId}`,
          ),
        ),
      )
      .returning({ id: billingReconciliationFindings.id });
    return rows.length;
  }

  async listFindings(input: {
    limit: number;
    cursor?: string;
    status?: BillingFindingStatus;
    severity?: BillingFindingSeverity;
    code?: string;
  }) {
    let cursorRow: { id: string; lastSeenAt: string } | undefined;
    if (input.cursor) {
      [cursorRow] = await this.db
        .select({
          id: billingReconciliationFindings.id,
          lastSeenAt: billingReconciliationFindings.lastSeenAt,
        })
        .from(billingReconciliationFindings)
        .where(eq(billingReconciliationFindings.id, input.cursor));
    }
    const predicates = [
      input.status
        ? eq(billingReconciliationFindings.status, input.status)
        : undefined,
      input.severity
        ? eq(billingReconciliationFindings.severity, input.severity)
        : undefined,
      input.code
        ? eq(billingReconciliationFindings.code, input.code)
        : undefined,
      cursorRow
        ? or(
            lt(billingReconciliationFindings.lastSeenAt, cursorRow.lastSeenAt),
            and(
              eq(
                billingReconciliationFindings.lastSeenAt,
                cursorRow.lastSeenAt,
              ),
              lt(billingReconciliationFindings.id, cursorRow.id),
            ),
          )
        : undefined,
    ].filter((value) => value !== undefined);
    const rows = await this.db
      .select()
      .from(billingReconciliationFindings)
      .where(predicates.length ? and(...predicates) : undefined)
      .orderBy(
        desc(billingReconciliationFindings.lastSeenAt),
        desc(billingReconciliationFindings.id),
      )
      .limit(input.limit + 1);
    return {
      rows: rows.slice(0, input.limit),
      nextCursor: rows.length > input.limit ? rows[input.limit - 1].id : null,
    };
  }

  async openFindingsForOrganization(orgId: string) {
    return this.db
      .select()
      .from(billingReconciliationFindings)
      .where(
        and(
          eq(billingReconciliationFindings.orgId, orgId),
          eq(billingReconciliationFindings.status, 'open'),
        ),
      )
      .orderBy(desc(billingReconciliationFindings.lastSeenAt))
      .limit(50);
  }

  async insertSettlement(
    actorId: string,
    idempotencyKey: string,
    input: SettlementInput,
  ) {
    const [duplicate] = await this.db
      .select()
      .from(billingSettlementReports)
      .where(
        and(
          eq(billingSettlementReports.actorId, actorId),
          eq(billingSettlementReports.idempotencyKey, idempotencyKey),
        ),
      );
    if (duplicate) {
      // Stored timestamps come back in PostgreSQL's text form, so a replay is
      // compared by instant rather than by string.
      const sameInstant = (stored: string, submitted: string) =>
        Date.parse(stored) === Date.parse(submitted);
      const same =
        duplicate.providerReportId === input.providerReportId &&
        duplicate.supersedesId === (input.supersedesId ?? null) &&
        sameInstant(duplicate.periodStart, input.periodStart) &&
        sameInstant(duplicate.periodEnd, input.periodEnd) &&
        sameInstant(duplicate.settledAt, input.settledAt) &&
        duplicate.currency === input.currency &&
        duplicate.transactionCount === input.transactionCount &&
        duplicate.grossMinor === input.grossMinor &&
        duplicate.refundedMinor === input.refundedMinor &&
        duplicate.chargebackMinor === input.chargebackMinor &&
        duplicate.feeMinor === input.feeMinor &&
        duplicate.vatMinor === input.vatMinor &&
        duplicate.netMinor === input.netMinor &&
        duplicate.evidence === input.evidence &&
        duplicate.reason === input.reason;
      return { row: duplicate, duplicate: true, conflict: !same };
    }

    let revision = 1;
    if (input.supersedesId) {
      const [previous] = await this.db
        .select()
        .from(billingSettlementReports)
        .where(eq(billingSettlementReports.id, input.supersedesId));
      if (!previous) return undefined;
      if (previous.providerReportId !== input.providerReportId)
        return undefined;
      revision = previous.revision + 1;
    }
    const [row] = await this.db
      .insert(billingSettlementReports)
      .values({
        ...input,
        provider: 'paymob',
        revision,
        actorId,
        idempotencyKey,
      })
      .returning();
    return { row, duplicate: false, conflict: false };
  }

  async resolveSettlementFindings(settlementId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .update(billingReconciliationFindings)
      .set({ status: 'resolved', resolvedAt: now, updatedAt: now })
      .where(
        and(
          eq(billingReconciliationFindings.settlementId, settlementId),
          eq(billingReconciliationFindings.status, 'open'),
        ),
      );
  }

  async listSettlements(limit: number, cursor?: string) {
    let cursorRow: { id: string; createdAt: string } | undefined;
    if (cursor)
      [cursorRow] = await this.db
        .select({
          id: billingSettlementReports.id,
          createdAt: billingSettlementReports.createdAt,
        })
        .from(billingSettlementReports)
        .where(eq(billingSettlementReports.id, cursor));
    const rows = await this.db
      .select()
      .from(billingSettlementReports)
      .where(
        cursorRow
          ? or(
              lt(billingSettlementReports.createdAt, cursorRow.createdAt),
              and(
                eq(billingSettlementReports.createdAt, cursorRow.createdAt),
                lt(billingSettlementReports.id, cursorRow.id),
              ),
            )
          : undefined,
      )
      .orderBy(
        desc(billingSettlementReports.createdAt),
        desc(billingSettlementReports.id),
      )
      .limit(limit + 1);
    const effectiveIds = new Set(
      (
        await this.db
          .select({ supersedesId: billingSettlementReports.supersedesId })
          .from(billingSettlementReports)
      )
        .map((row) => row.supersedesId)
        .filter((value): value is string => !!value),
    );
    return {
      rows: rows.slice(0, limit).map((row) => ({
        ...row,
        effective: !effectiveIds.has(row.id),
      })),
      nextCursor: rows.length > limit ? rows[limit - 1].id : null,
    };
  }

  async effectiveSettlement(settlementId: string) {
    const [row] = await this.db
      .select()
      .from(billingSettlementReports)
      .where(
        and(
          eq(billingSettlementReports.id, settlementId),
          notExists(
            this.db
              .select({ id: billingSettlementReports.id })
              .from(billingSettlementReports)
              .where(eq(billingSettlementReports.supersedesId, settlementId)),
          ),
        ),
      );
    return row;
  }

  async cleanup(now = new Date()): Promise<void> {
    const attemptsBefore = new Date(
      now.getTime() - 180 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const findingsBefore = new Date(
      now.getTime() - 365 * 24 * 60 * 60 * 1000,
    ).toISOString();
    await this.db
      .delete(billingReconciliationAttempts)
      .where(lt(billingReconciliationAttempts.attemptedAt, attemptsBefore));
    await this.db
      .delete(billingReconciliationFindings)
      .where(
        and(
          eq(billingReconciliationFindings.status, 'resolved'),
          lt(billingReconciliationFindings.resolvedAt, findingsBefore),
        ),
      );
    await this.db.execute(sql`
      DELETE FROM ${billingReconciliationRuns} run
      WHERE run.completed_at < ${attemptsBefore}::timestamptz
        AND NOT EXISTS (
          SELECT 1 FROM ${billingReconciliationAttempts} attempt
          WHERE attempt.run_id = run.id
        )
    `);
  }

  async healthFacts(
    from: string | null,
    to: string | null,
    slowMs: number,
    lowBalanceThreshold: number,
  ) {
    const range = sql`(${from}::timestamptz IS NULL OR purchase.created_at >= ${from}::timestamptz)
      AND (${to}::timestamptz IS NULL OR purchase.created_at < ${to}::timestamptz)`;
    const [purchases] = await this.db.execute<{
      checkoutStarts: number;
      successfulPurchases: number;
      payingOrganizations: number;
      purchasedCredits: number;
      grossMinor: number;
      firstPurchases: number;
      repeatPurchases: number;
      averagePurchaseCredits: number;
    }>(sql`
      WITH ranked AS (
        SELECT purchase.*, row_number() OVER (
          PARTITION BY purchase.org_id ORDER BY purchase.created_at, purchase.id
        ) AS paid_rank
        FROM ${paymentPurchases} purchase
        WHERE purchase.status IN ('successful', 'refunded')
      )
      SELECT
        (SELECT count(*)::int FROM ${paymentPurchases} purchase WHERE ${range}) AS "checkoutStarts",
        count(*) FILTER (WHERE ${range})::int AS "successfulPurchases",
        count(DISTINCT purchase.org_id) FILTER (WHERE ${range})::int AS "payingOrganizations",
        coalesce(sum(purchase.quantity) FILTER (WHERE ${range}), 0)::int AS "purchasedCredits",
        coalesce(sum(purchase.total_minor) FILTER (WHERE ${range}), 0)::bigint AS "grossMinor",
        count(*) FILTER (WHERE ${range} AND paid_rank = 1)::int AS "firstPurchases",
        count(*) FILTER (WHERE ${range} AND paid_rank > 1)::int AS "repeatPurchases",
        coalesce(avg(purchase.quantity) FILTER (WHERE ${range}), 0)::float8 AS "averagePurchaseCredits"
      FROM ranked purchase
    `);
    const [accounts] = await this.db.execute<{
      activatedOrganizations: number;
      lowBalanceOrganizations: number;
      zeroBalanceOrganizations: number;
    }>(sql`
      SELECT
        count(*) FILTER (WHERE status = 'active')::int AS "activatedOrganizations",
        count(*) FILTER (WHERE greatest(posted_balance - held_credits, 0) BETWEEN 1 AND ${lowBalanceThreshold})::int AS "lowBalanceOrganizations",
        count(*) FILTER (WHERE posted_balance - held_credits <= 0)::int AS "zeroBalanceOrganizations"
      FROM ${creditAccounts}
    `);
    const [ledger] = await this.db.execute<{
      launchGrants: number;
      freeCredits: number;
      initialConsumption: number;
      followUpConsumption: number;
      failureReversals: number;
      refundedMinor: number;
      chargebackMinor: number;
    }>(sql`
      SELECT
        count(*) FILTER (WHERE entry.type = 'free_grant')::int AS "launchGrants",
        coalesce(sum(entry.quantity) FILTER (WHERE entry.type = 'free_grant'), 0)::int AS "freeCredits",
        coalesce(-sum(entry.quantity) FILTER (WHERE entry.type = 'consumption' AND dispatch.kind = 'initial'), 0)::int AS "initialConsumption",
        coalesce(-sum(entry.quantity) FILTER (WHERE entry.type = 'consumption' AND dispatch.kind = 'follow_up'), 0)::int AS "followUpConsumption",
        coalesce(sum(entry.quantity) FILTER (WHERE entry.type = 'failure_reversal'), 0)::int AS "failureReversals",
        coalesce(-sum(entry.quantity * purchase.unit_price_minor) FILTER (WHERE entry.type = 'refund_reversal'), 0)::bigint AS "refundedMinor",
        coalesce(-sum(entry.quantity * purchase.unit_price_minor) FILTER (WHERE entry.type = 'chargeback_reversal'), 0)::bigint AS "chargebackMinor"
      FROM ${creditLedgerEntries} entry
      LEFT JOIN verification_message_dispatches dispatch ON dispatch.id = entry.dispatch_id
      LEFT JOIN ${paymentPurchases} purchase ON purchase.id = entry.purchase_id
      WHERE (${from}::timestamptz IS NULL OR entry.created_at >= ${from}::timestamptz)
        AND (${to}::timestamptz IS NULL OR entry.created_at < ${to}::timestamptz)
    `);
    const [findings] = await this.db.execute<{
      openCount: number;
      criticalCount: number;
      oldestOpenAt: string | null;
    }>(sql`
      SELECT
        count(*) FILTER (WHERE status = 'open')::int AS "openCount",
        count(*) FILTER (WHERE status = 'open' AND severity = 'critical')::int AS "criticalCount",
        min(first_seen_at) FILTER (WHERE status = 'open') AS "oldestOpenAt"
      FROM ${billingReconciliationFindings}
    `);
    const [provider] = await this.db.execute<{
      attempts: number;
      failures: number;
      slow: number;
      averageDurationMs: number;
    }>(sql`
      SELECT
        count(*)::int AS attempts,
        count(*) FILTER (WHERE outcome = 'deferred')::int AS failures,
        count(*) FILTER (WHERE duration_ms >= ${slowMs})::int AS slow,
        coalesce(avg(duration_ms), 0)::int AS "averageDurationMs"
      FROM ${billingReconciliationAttempts}
      WHERE target_kind = 'provider_inquiry'
        AND attempted_at >= now() - interval '24 hours'
    `);
    const purchaseStates = await this.db.execute<{
      status: string;
      count: number;
    }>(sql`
      SELECT purchase.status, count(*)::int AS count
      FROM ${paymentPurchases} purchase
      WHERE ${range}
      GROUP BY purchase.status
      ORDER BY purchase.status
    `);
    const purchaseSizes = await this.db.execute<{
      quantity: number;
      count: number;
    }>(sql`
      SELECT purchase.quantity, count(*)::int AS count
      FROM ${paymentPurchases} purchase
      WHERE purchase.status IN ('successful', 'refunded') AND ${range}
      GROUP BY purchase.quantity
      ORDER BY purchase.quantity
    `);
    const [firstAccepted] = await this.db.execute<{
      averageSeconds: number | null;
      sampleSize: number;
    }>(sql`
      WITH first_consumption AS (
        SELECT entry.org_id, min(entry.created_at) AS consumed_at
        FROM ${creditLedgerEntries} entry
        WHERE entry.type = 'consumption'
        GROUP BY entry.org_id
      )
      SELECT
        avg(extract(epoch FROM (first_consumption.consumed_at - grant_entry.created_at)))::float8 AS "averageSeconds",
        count(*)::int AS "sampleSize"
      FROM ${creditLedgerEntries} grant_entry
      JOIN first_consumption ON first_consumption.org_id = grant_entry.org_id
      WHERE grant_entry.type = 'free_grant'
        AND (${from}::timestamptz IS NULL OR grant_entry.created_at >= ${from}::timestamptz)
        AND (${to}::timestamptz IS NULL OR grant_entry.created_at < ${to}::timestamptz)
    `);
    return {
      purchases,
      accounts,
      ledger,
      findings,
      provider,
      purchaseStates: [...purchaseStates],
      purchaseSizes: [...purchaseSizes],
      firstAccepted,
    };
  }

  async liabilityLedger(asOf: string | null) {
    const rows = await this.db.execute<{
      id: string;
      orgId: string;
      type: string;
      quantity: number;
      purchaseId: string | null;
      sourceLedgerEntryId: string | null;
      unitPriceMinor: number | null;
    }>(sql`
      SELECT
        entry.id,
        entry.org_id AS "orgId",
        entry.type,
        entry.quantity,
        entry.purchase_id AS "purchaseId",
        entry.source_ledger_entry_id AS "sourceLedgerEntryId",
        purchase.unit_price_minor AS "unitPriceMinor"
      FROM ${creditLedgerEntries} entry
      LEFT JOIN ${paymentPurchases} purchase ON purchase.id = entry.purchase_id
      WHERE (${asOf}::timestamptz IS NULL OR entry.created_at < ${asOf}::timestamptz)
      ORDER BY entry.created_at, entry.id
    `);
    return [...rows];
  }

  async effectiveSettlementTotals(from: string | null, to: string | null) {
    const [row] = await this.db.execute<{
      reports: number;
      periodStart: string | null;
      periodEnd: string | null;
      feeMinor: number;
      vatMinor: number;
      netMinor: number;
    }>(sql`
      SELECT
        count(*)::int AS reports,
        min(report.period_start) AS "periodStart",
        max(report.period_end) AS "periodEnd",
        coalesce(sum(report.fee_minor), 0)::bigint AS "feeMinor",
        coalesce(sum(report.vat_minor), 0)::bigint AS "vatMinor",
        coalesce(sum(report.net_minor), 0)::bigint AS "netMinor"
      FROM ${billingSettlementReports} report
      WHERE NOT EXISTS (
        SELECT 1 FROM ${billingSettlementReports} correction
        WHERE correction.supersedes_id = report.id
      )
        AND (${from}::timestamptz IS NULL OR report.period_end > ${from}::timestamptz)
        AND (${to}::timestamptz IS NULL OR report.period_start < ${to}::timestamptz)
    `);
    return row;
  }

  async settlementExpected(periodStart: string, periodEnd: string) {
    const [row] = await this.db.execute<{
      transactionCount: number;
      grossMinor: number;
      refundedMinor: number;
      chargebackMinor: number;
    }>(sql`
      WITH grants AS (
        SELECT purchase_id, quantity
        FROM ${creditLedgerEntries}
        WHERE type = 'purchase'
          AND created_at >= ${periodStart}::timestamptz
          AND created_at < ${periodEnd}::timestamptz
      ), reversals AS (
        SELECT
          entry.purchase_id,
          coalesce(-sum(entry.quantity * purchase.unit_price_minor) FILTER (WHERE entry.type = 'refund_reversal'), 0)::bigint AS refunded_minor,
          coalesce(-sum(entry.quantity * purchase.unit_price_minor) FILTER (WHERE entry.type = 'chargeback_reversal'), 0)::bigint AS chargeback_minor
        FROM ${creditLedgerEntries} entry
        JOIN ${paymentPurchases} purchase ON purchase.id = entry.purchase_id
        WHERE entry.created_at >= ${periodStart}::timestamptz
          AND entry.created_at < ${periodEnd}::timestamptz
        GROUP BY entry.purchase_id
      )
      SELECT
        count(grants.purchase_id)::int AS "transactionCount",
        coalesce(sum(grants.quantity * purchase.unit_price_minor), 0)::bigint AS "grossMinor",
        coalesce(sum(reversals.refunded_minor), 0)::bigint AS "refundedMinor",
        coalesce(sum(reversals.chargeback_minor), 0)::bigint AS "chargebackMinor"
      FROM grants
      JOIN ${paymentPurchases} purchase ON purchase.id = grants.purchase_id
      FULL JOIN reversals ON reversals.purchase_id = purchase.id
    `);
    return row;
  }
}
