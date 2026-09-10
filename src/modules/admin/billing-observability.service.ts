import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  readStandaloneBillingObservabilityConfig,
  type StandaloneBillingObservabilityConfig,
} from '../../shared/config/standalone-billing-observability.config';
import {
  readStandaloneCreditBillingConfig,
  type StandaloneCreditBillingConfig,
} from '../../shared/config/standalone-credit-billing.config';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import { paymentEventMismatch } from '../billing/payment-callback.service';
import { PaymentReconciliationService } from '../billing/payment-reconciliation.service';
import { AdminAccessAuditRepository } from '../../infrastructure/database/repositories/admin-access-audit.repository';
import { StandaloneBillingOperationsRepository } from './standalone-billing-operations.repository';
import { BillingObservabilityRepository } from './billing-observability.repository';
import { BillingReconciliationProducer } from './billing-reconciliation.producer';
import {
  BILLING_OBSERVABILITY_ACTIONS,
  type BillingFindingInput,
  type SettlementInput,
} from './billing-observability.types';

const LOCAL_CODES = [
  'projection_mismatch',
  'source_contradiction',
  'provider_success_without_grant',
  'grant_without_verified_success',
  'refund_dispute_discrepancy',
  'stale_pending',
  'trusted_data_mismatch',
  'duplicate_provider_id',
  'credit_debt',
  'refund_state',
  'chargeback_state',
] as const;

@Injectable()
export class BillingObservabilityService {
  private readonly logger = new Logger(BillingObservabilityService.name);
  private readonly settings: StandaloneBillingObservabilityConfig;
  private readonly billing: StandaloneCreditBillingConfig;

  constructor(
    private readonly repository: BillingObservabilityRepository,
    private readonly operations: StandaloneBillingOperationsRepository,
    private readonly reconciliation: PaymentReconciliationService,
    private readonly producer: BillingReconciliationProducer,
    private readonly audit: AdminAccessAuditRepository,
    config: ConfigService,
  ) {
    this.settings = readStandaloneBillingObservabilityConfig(config);
    this.billing = readStandaloneCreditBillingConfig(config);
  }

  async processRun(runId: string): Promise<void> {
    if (!(await this.repository.claimRun(runId))) return;
    const run = await this.repository.run(runId);
    // A resumed run starts from the counts its failed attempt stored, since
    // the targets it completed are skipped rather than counted again.
    const counters = {
      candidates: 0,
      attempted: run?.attempted ?? 0,
      resolved: run?.resolved ?? 0,
      deferred: run?.deferred ?? 0,
      findingsOpened: run?.findingsOpened ?? 0,
      findingsResolved: 0,
    };
    try {
      await this.scanAccounts(runId, counters);
      await this.scanStaticSignals(runId, counters);
      await this.scanPurchases(runId, counters);
      if (run?.settlementId)
        await this.compareSettlement(runId, run.settlementId, counters);
      // A deferred inquiry is only re-checked while scheduled inquiry runs;
      // turning the switch off must not make it look resolved.
      counters.findingsResolved += await this.repository.resolveUnseen(runId, [
        ...LOCAL_CODES,
        ...(this.settings.scheduledInquiryEnabled
          ? ['provider_inquiry_deferred']
          : []),
      ]);
      await this.repository.cleanup();
      await this.repository.finishRun(runId, 'completed', counters);
      await this.emitBacklogAlert();
      this.logger.log(
        buildBackendLog(BillingObservabilityService.name, {
          action: 'standalone-billing-metric-summary',
          outcome: 'success',
          runId,
          ...counters,
        }),
      );
    } catch (error) {
      await this.repository.finishRun(runId, 'failed', counters);
      this.logger.error(
        buildBackendLog(BillingObservabilityService.name, {
          action: 'billing-reconciliation-run',
          outcome: 'failure',
          runId,
          ...normalizeError(error),
        }),
      );
      throw error;
    }
  }

  async health(from?: string, to?: string) {
    const [facts, settlements, latestRun, liabilityLedger] = await Promise.all([
      this.repository.healthFacts(
        from ?? null,
        to ?? null,
        this.settings.paymobSlowMs,
        this.billing.lowBalanceThreshold,
      ),
      this.repository.effectiveSettlementTotals(from ?? null, to ?? null),
      this.repository.latestRun(),
      this.repository.liabilityLedger(to ?? null),
    ]);
    const oldestAgeMinutes = facts.findings.oldestOpenAt
      ? Math.floor(
          (Date.now() - Date.parse(facts.findings.oldestOpenAt)) / 60_000,
        )
      : 0;
    const backlogAlert =
      facts.findings.openCount >= this.settings.backlogAlertCount ||
      oldestAgeMinutes >= this.settings.backlogAlertAgeMinutes;
    const providerErrorRate = facts.provider.attempts
      ? Math.round(
          (facts.provider.failures / facts.provider.attempts) * 10_000,
        ) / 100
      : 0;
    const providerDegraded =
      facts.provider.attempts >= this.settings.paymobErrorRateMinAttempts &&
      providerErrorRate >= this.settings.paymobErrorRatePercent;
    const settlementCovered =
      !!from &&
      !!to &&
      settlements.reports > 0 &&
      !!settlements.periodStart &&
      Date.parse(settlements.periodStart) <= Date.parse(from) &&
      !!settlements.periodEnd &&
      Date.parse(settlements.periodEnd) >= Date.parse(to);
    const acceptedMessages =
      facts.ledger.initialConsumption + facts.ledger.followUpConsumption;
    const netRevenueMinor = settlementCovered
      ? Number(settlements.netMinor)
      : null;
    const liability = this.liability(liabilityLedger);
    return {
      evaluatedAt: new Date().toISOString(),
      range: { from: from ?? null, to: to ?? null },
      health: {
        status:
          facts.findings.criticalCount > 0
            ? 'critical'
            : backlogAlert || providerDegraded
              ? 'attention'
              : 'healthy',
        latestRun,
        scheduledInquiryEnabled: this.settings.scheduledInquiryEnabled,
        reportOnly: this.settings.reportOnly,
        cron: this.settings.cron,
        timezone: this.settings.timezone,
        openFindings: facts.findings.openCount,
        criticalFindings: facts.findings.criticalCount,
        oldestFindingAgeMinutes: oldestAgeMinutes,
        backlogAlert,
        provider: {
          ...facts.provider,
          errorRatePercent: providerErrorRate,
          degraded: providerDegraded,
        },
      },
      product: {
        ...facts.accounts,
        launchGrants: facts.ledger.launchGrants,
        freeCreditsGranted: facts.ledger.freeCredits,
        freeUtilizationPercent: facts.ledger.freeCredits
          ? Math.min(
              100,
              Math.round(
                (acceptedMessages / facts.ledger.freeCredits) * 10_000,
              ) / 100,
            )
          : 0,
        checkoutStarts: facts.purchases.checkoutStarts,
        successfulPurchases: facts.purchases.successfulPurchases,
        firstPurchases: facts.purchases.firstPurchases,
        repeatPurchases: facts.purchases.repeatPurchases,
        averagePurchaseCredits: facts.purchases.averagePurchaseCredits,
        purchaseStates: Object.fromEntries(
          facts.purchaseStates.map((row) => [row.status, row.count]),
        ),
        purchaseSizeDistribution: facts.purchaseSizes,
        averageTimeToFirstAcceptedSeconds:
          facts.firstAccepted.averageSeconds === null
            ? null
            : Math.round(facts.firstAccepted.averageSeconds),
        firstAcceptedSampleSize: facts.firstAccepted.sampleSize,
        paidConversionPercent: facts.purchases.checkoutStarts
          ? Math.round(
              (facts.purchases.successfulPurchases /
                facts.purchases.checkoutStarts) *
                10_000,
            ) / 100
          : 0,
        initialConsumption: facts.ledger.initialConsumption,
        followUpConsumption: facts.ledger.followUpConsumption,
        failureReversals: facts.ledger.failureReversals,
      },
      finance: {
        purchasedCredits: facts.purchases.purchasedCredits,
        grossMinor: Number(facts.purchases.grossMinor),
        refundedMinor: Number(facts.ledger.refundedMinor),
        chargebackMinor: Number(facts.ledger.chargebackMinor),
        unspentPaidCredits: liability.credits,
        unspentPaidCreditLiabilityMinor: liability.minor,
        feeMinor: settlementCovered ? Number(settlements.feeMinor) : null,
        vatMinor: settlementCovered ? Number(settlements.vatMinor) : null,
        netRevenueMinor,
        payingOrganizations: facts.purchases.payingOrganizations,
        arppuMinor:
          netRevenueMinor !== null && facts.purchases.payingOrganizations
            ? Math.round(netRevenueMinor / facts.purchases.payingOrganizations)
            : null,
        revenuePerAcceptedMessageMinor:
          netRevenueMinor !== null && acceptedMessages
            ? Math.round(netRevenueMinor / acceptedMessages)
            : null,
      },
      settlementCoverage: {
        complete: settlementCovered,
        reports: settlements.reports,
        periodStart: settlements.periodStart,
        periodEnd: settlements.periodEnd,
      },
    };
  }

  listFindings(
    input: Parameters<BillingObservabilityRepository['listFindings']>[0],
  ) {
    return this.repository.listFindings(input);
  }

  listSettlements(limit: number, cursor?: string) {
    return this.repository.listSettlements(limit, cursor);
  }

  openFindingsForOrganization(orgId: string) {
    return this.repository.openFindingsForOrganization(orgId);
  }

  async requestRun(userId: string, reason: string, requestId?: string) {
    const run = await this.producer.enqueue({
      trigger: 'manual',
      triggeredBy: userId,
      reason,
    });
    await this.audit.record({
      userId,
      action: BILLING_OBSERVABILITY_ACTIONS.run,
      outcome: 'allowed',
      requestId,
      metadata: { reason, runId: run.id, mode: run.mode },
    });
    return { runId: run.id, status: run.status, mode: run.mode };
  }

  async recordSettlement(input: {
    userId: string;
    idempotencyKey?: string;
    settlement: SettlementInput;
    requestId?: string;
  }) {
    const key = input.idempotencyKey?.trim();
    if (!key)
      throw new BadRequestException({
        code: 'BILLING_IDEMPOTENCY_KEY_REQUIRED',
        message: 'Idempotency-Key is required',
      });
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key))
      throw new BadRequestException({
        code: 'BILLING_IDEMPOTENCY_KEY_INVALID',
        message: 'Idempotency-Key is invalid',
      });
    if (
      Date.parse(input.settlement.periodStart) >=
      Date.parse(input.settlement.periodEnd)
    )
      throw new BadRequestException({
        code: 'BILLING_SETTLEMENT_PERIOD_INVALID',
        message: 'Settlement period start must be before its end',
      });
    let recorded: Awaited<
      ReturnType<BillingObservabilityRepository['insertSettlement']>
    >;
    try {
      recorded = await this.repository.insertSettlement(
        input.userId,
        key,
        input.settlement,
      );
    } catch {
      throw new ConflictException({
        code: 'BILLING_SETTLEMENT_CONFLICT',
        message: 'Settlement correction conflicts with existing evidence',
      });
    }
    if (!recorded)
      throw new NotFoundException({
        code: 'BILLING_SETTLEMENT_NOT_FOUND',
        message: 'Settlement to correct was not found',
      });
    if (recorded.conflict)
      throw new ConflictException({
        code: 'BILLING_IDEMPOTENCY_CONFLICT',
        message:
          'Idempotency-Key was already used for different settlement evidence',
      });
    if (!recorded.duplicate) {
      if (input.settlement.supersedesId)
        await this.repository.resolveSettlementFindings(
          input.settlement.supersedesId,
        );
      await this.audit.record({
        userId: input.userId,
        action: BILLING_OBSERVABILITY_ACTIONS.settlement,
        outcome: 'allowed',
        requestId: input.requestId,
        metadata: {
          settlementId: recorded.row.id,
          providerReportId: recorded.row.providerReportId,
          revision: recorded.row.revision,
          reason: input.settlement.reason,
          evidence: input.settlement.evidence,
        },
      });
      await this.producer.enqueue({
        trigger: 'settlement',
        settlementId: recorded.row.id,
        triggeredBy: input.userId,
        reason: input.settlement.reason,
        runKey: `settlement:${recorded.row.id}`,
      });
    }
    return { ...recorded.row, duplicate: recorded.duplicate };
  }

  private async scanAccounts(
    runId: string,
    counters: {
      attempted: number;
      findingsOpened: number;
    },
  ): Promise<void> {
    let cursor: string | undefined;
    do {
      const orgIds = await this.repository.organizationIds({
        limit: this.settings.batchSize,
        cursor,
      });
      for (const orgId of orgIds) {
        if (await this.repository.hasAttempt(runId, 'account_invariant', orgId))
          continue;
        const report = await this.operations.readReconciliation(orgId);
        counters.attempted += 1;
        if (report && !report.consistent)
          counters.findingsOpened += await this.find(runId, {
            code: 'projection_mismatch',
            severity: 'critical',
            nextAction: 'repair_projection',
            orgId,
            safeContext: {
              postedDifference: report.postedDifference,
              heldDifference: report.heldDifference,
            },
          });
        for (const contradiction of report?.contradictions ?? [])
          counters.findingsOpened += await this.find(runId, {
            code:
              contradiction.code === 'purchase_entry_without_success'
                ? 'grant_without_verified_success'
                : contradiction.code === 'purchase_success_without_entry'
                  ? 'provider_success_without_grant'
                  : contradiction.code.startsWith('purchase_')
                    ? 'refund_dispute_discrepancy'
                    : 'source_contradiction',
            severity: 'critical',
            nextAction: 'investigate_sources',
            orgId,
            safeContext: { ...contradiction },
          });
        // Recorded only after its findings persist: a resumed run skips this
        // account, and a skipped account must not look unseen.
        await this.repository.recordAttempt({
          runId,
          orgId,
          targetKind: 'account_invariant',
          targetKey: orgId,
          outcome: report?.consistent ? 'consistent' : 'mismatch',
          durationMs: 0,
        });
      }
      cursor =
        orgIds.length === this.settings.batchSize
          ? orgIds[orgIds.length - 1]
          : undefined;
    } while (cursor);
  }

  private async scanPurchases(
    runId: string,
    counters: {
      candidates: number;
      attempted: number;
      resolved: number;
      deferred: number;
      findingsOpened: number;
    },
  ): Promise<void> {
    const staleBefore = new Date(
      Date.now() - this.settings.stalePendingMinutes * 60_000,
    ).toISOString();
    const lookbackSince = new Date(
      Date.now() - this.settings.lookbackDays * 24 * 60 * 60_000,
    ).toISOString();
    let cursor: { createdAt: string; id: string } | undefined;
    do {
      const candidates = await this.repository.candidates({
        staleBefore,
        lookbackSince,
        limit: this.settings.batchSize,
        cursor,
      });
      counters.candidates += candidates.length;
      for (const purchase of candidates) {
        if (
          await this.repository.hasAttempt(
            runId,
            'purchase_scan',
            purchase.reference,
          )
        )
          continue;
        if (
          await this.repository.hasAttempt(
            runId,
            'provider_inquiry',
            purchase.reference,
          )
        ) {
          // The inquiry finished before the run was interrupted. Never ask
          // twice in one run; keep what is already open for it open.
          await this.repository.carryPurchaseFindings(runId, purchase.id);
          await this.repository.recordAttempt({
            runId,
            orgId: purchase.orgId,
            purchaseId: purchase.id,
            targetKind: 'purchase_scan',
            targetKey: purchase.reference,
            outcome: 'resumed',
            durationMs: 0,
          });
          continue;
        }
        if (
          purchase.status === 'pending' &&
          purchase.checkoutExpiresAt &&
          Date.parse(purchase.checkoutExpiresAt) <= Date.parse(staleBefore)
        )
          counters.findingsOpened += await this.find(runId, {
            code: 'stale_pending',
            severity: 'attention',
            nextAction: this.settings.scheduledInquiryEnabled
              ? 'retry_provider_inquiry'
              : 'enable_scheduled_inquiry',
            orgId: purchase.orgId,
            purchaseId: purchase.id,
            safeContext: { reference: purchase.reference },
          });
        if (!this.settings.scheduledInquiryEnabled) {
          await this.repository.recordAttempt({
            runId,
            orgId: purchase.orgId,
            purchaseId: purchase.id,
            targetKind: 'purchase_scan',
            targetKey: purchase.reference,
            outcome: 'local_only',
            durationMs: 0,
          });
          continue;
        }
        const poison: Omit<BillingFindingInput, 'fingerprint'> = {
          code: 'provider_inquiry_deferred',
          severity: 'attention',
          nextAction: 'retry_provider_inquiry',
          orgId: purchase.orgId,
          purchaseId: purchase.id,
          safeContext: { reference: purchase.reference },
        };
        const previous = await this.repository.finding(
          this.fingerprint(poison),
        );
        const backoff = previous?.status === 'open' ? previous : undefined;
        if (
          backoff?.nextAttemptAt &&
          Date.parse(backoff.nextAttemptAt) > Date.now()
        ) {
          // Still inside its backoff window: keep it open and unchanged
          // rather than asking Paymob again.
          await this.find(runId, {
            ...poison,
            retryCount: backoff.retryCount,
            nextAttemptAt: backoff.nextAttemptAt,
          });
          await this.repository.recordAttempt({
            runId,
            orgId: purchase.orgId,
            purchaseId: purchase.id,
            targetKind: 'purchase_scan',
            targetKey: purchase.reference,
            outcome: 'backoff',
            durationMs: 0,
          });
          continue;
        }
        const started = Date.now();
        const result = await this.reconciliation.reconcile(
          purchase.orgId,
          purchase.reference,
          {
            scheduled: true,
            reportOnly: this.settings.reportOnly,
          },
        );
        const durationMs = Date.now() - started;
        counters.attempted += 1;
        if (result.outcome === 'resolved') counters.resolved += 1;
        if (result.outcome === 'deferred') counters.deferred += 1;
        await this.repository.recordAttempt({
          runId,
          orgId: purchase.orgId,
          purchaseId: purchase.id,
          targetKind: 'provider_inquiry',
          targetKey: purchase.reference,
          outcome: result.outcome,
          errorCode: result.providerCode,
          durationMs,
        });
        if (durationMs >= this.settings.paymobSlowMs)
          this.alert('paymob_slow', 'attention', {
            durationMs,
            reference: purchase.reference,
          });
        if (result.providerEvent) {
          const mismatch = paymentEventMismatch(
            result.providerEvent,
            purchase as never,
            this.billing,
          );
          if (mismatch)
            counters.findingsOpened += await this.find(runId, {
              code: 'trusted_data_mismatch',
              severity: 'critical',
              nextAction: 'review_purchase',
              orgId: purchase.orgId,
              purchaseId: purchase.id,
              safeContext: {
                reference: purchase.reference,
                errorCode: mismatch,
              },
            });
          // Active mode already ingested the fact; report-only must say what
          // it would have changed.
          else if (this.settings.reportOnly) {
            const event = result.providerEvent;
            if (
              event.signal === 'success' &&
              !['successful', 'refunded'].includes(purchase.status)
            )
              counters.findingsOpened += await this.find(runId, {
                code: 'provider_success_without_grant',
                severity: 'critical',
                nextAction: 'retry_provider_inquiry',
                orgId: purchase.orgId,
                purchaseId: purchase.id,
                safeContext: { reference: purchase.reference },
              });
            if (
              event.refundedMinorTotal !== undefined &&
              event.refundedMinorTotal !== Number(purchase.refundedMinor)
            )
              counters.findingsOpened += await this.find(runId, {
                code: 'refund_dispute_discrepancy',
                severity: 'critical',
                nextAction: 'review_refund_dispute',
                orgId: purchase.orgId,
                purchaseId: purchase.id,
                safeContext: {
                  reference: purchase.reference,
                  providerRefundedMinor: event.refundedMinorTotal,
                  refundedMinor: Number(purchase.refundedMinor),
                },
              });
          }
        }
        if (result.outcome === 'deferred') {
          const retryCount = (backoff?.retryCount ?? 0) + 1;
          counters.findingsOpened += await this.find(runId, {
            ...poison,
            retryCount,
            nextAttemptAt: new Date(
              Date.now() + this.backoffMs(retryCount),
            ).toISOString(),
            // `providerCode`, not `errorCode`: the latter is part of the
            // fingerprint and would fork one finding per provider answer.
            safeContext: {
              ...poison.safeContext,
              ...(result.providerCode
                ? { providerCode: result.providerCode }
                : {}),
            },
          });
        }
        await this.repository.recordAttempt({
          runId,
          orgId: purchase.orgId,
          purchaseId: purchase.id,
          targetKind: 'purchase_scan',
          targetKey: purchase.reference,
          outcome: result.outcome,
          durationMs,
        });
      }
      const last = candidates[candidates.length - 1];
      cursor =
        candidates.length === this.settings.batchSize
          ? { createdAt: last.createdAt, id: last.id }
          : undefined;
    } while (cursor);
  }

  private async scanStaticSignals(
    runId: string,
    counters: { findingsOpened: number },
  ): Promise<void> {
    for (const signal of await this.repository.staticSignals()) {
      const targetKey = `${signal.code}:${signal.identity}`;
      if (await this.repository.hasAttempt(runId, 'static_signal', targetKey))
        continue;
      counters.findingsOpened += await this.find(runId, {
        code: signal.code,
        severity: signal.severity,
        nextAction: signal.nextAction,
        orgId: signal.orgId ?? undefined,
        purchaseId: signal.purchaseId ?? undefined,
        safeContext: {
          identity: signal.identity,
          ...(signal.errorCode ? { errorCode: signal.errorCode } : {}),
        },
      });
      await this.repository.recordAttempt({
        runId,
        orgId: signal.orgId ?? undefined,
        purchaseId: signal.purchaseId ?? undefined,
        targetKind: 'static_signal',
        targetKey,
        outcome: 'detected',
        durationMs: 0,
      });
    }
  }

  private async compareSettlement(
    runId: string,
    settlementId: string,
    counters: { attempted: number; findingsOpened: number },
  ): Promise<void> {
    if (
      await this.repository.hasAttempt(
        runId,
        'settlement_compare',
        settlementId,
      )
    )
      return;
    const report = await this.repository.effectiveSettlement(settlementId);
    if (!report) return;
    const expected = await this.repository.settlementExpected(
      report.periodStart,
      report.periodEnd,
    );
    const expectedNet =
      expected.grossMinor -
      expected.refundedMinor -
      expected.chargebackMinor -
      report.feeMinor -
      report.vatMinor;
    const differences = {
      transactionCount: report.transactionCount - expected.transactionCount,
      grossMinor: report.grossMinor - expected.grossMinor,
      refundedMinor: report.refundedMinor - expected.refundedMinor,
      chargebackMinor: report.chargebackMinor - expected.chargebackMinor,
      netMinor: report.netMinor - expectedNet,
      providerArithmeticMinor:
        report.netMinor -
        (report.grossMinor -
          report.refundedMinor -
          report.chargebackMinor -
          report.feeMinor -
          report.vatMinor),
    };
    const mismatch = Object.values(differences).some((value) => value !== 0);
    counters.attempted += 1;
    if (mismatch)
      counters.findingsOpened += await this.find(runId, {
        code: 'settlement_difference',
        severity: 'attention',
        nextAction: 'review_settlement',
        settlementId,
        safeContext: {
          providerReportId: report.providerReportId,
          currency: report.currency,
          differences,
        },
      });
    await this.repository.recordAttempt({
      runId,
      targetKind: 'settlement_compare',
      targetKey: settlementId,
      outcome: mismatch ? 'mismatch' : 'matched',
      durationMs: 0,
    });
  }

  private fingerprint(input: Omit<BillingFindingInput, 'fingerprint'>): string {
    return createHash('sha256')
      .update(
        [
          input.code,
          input.orgId ?? '',
          input.purchaseId ?? '',
          input.settlementId ?? '',
          this.fingerprintPart(input.safeContext?.reference),
          this.fingerprintPart(input.safeContext?.reservationId),
          this.fingerprintPart(input.safeContext?.purchaseRef),
          this.fingerprintPart(input.safeContext?.errorCode),
        ].join('|'),
      )
      .digest('hex');
  }

  /** 15 minutes doubling per failure, capped at one day. */
  private backoffMs(retryCount: number): number {
    return Math.min(
      15 * 60_000 * 2 ** Math.max(0, retryCount - 1),
      24 * 60 * 60_000,
    );
  }

  private async find(
    runId: string,
    input: Omit<BillingFindingInput, 'fingerprint'>,
  ): Promise<number> {
    const result = await this.repository.upsertFinding(runId, {
      ...input,
      fingerprint: this.fingerprint(input),
    });
    if (result === 'opened') {
      this.alert(input.code, input.severity, {
        orgId: input.orgId,
        purchaseId: input.purchaseId,
        settlementId: input.settlementId,
      });
      return 1;
    }
    return 0;
  }

  private liability(
    rows: Awaited<
      ReturnType<BillingObservabilityRepository['liabilityLedger']>
    >,
  ): { credits: number; minor: number } {
    interface PaidBatch {
      credits: number;
      priceMinor: number;
    }
    interface Allocation {
      nonCash: number;
      paid: { purchaseId: string; credits: number }[];
    }
    interface State {
      nonCash: number;
      paid: Map<string, PaidBatch>;
      allocations: Map<string, Allocation>;
    }
    const states = new Map<string, State>();
    const takePaid = (
      state: State,
      requested: number,
    ): { purchaseId: string; credits: number }[] => {
      let remaining = requested;
      const taken: { purchaseId: string; credits: number }[] = [];
      for (const [purchaseId, batch] of state.paid) {
        if (remaining <= 0) break;
        const credits = Math.min(batch.credits, remaining);
        if (!credits) continue;
        batch.credits -= credits;
        remaining -= credits;
        taken.push({ purchaseId, credits });
      }
      return taken;
    };

    for (const row of rows) {
      const state = states.get(row.orgId) ?? {
        nonCash: 0,
        paid: new Map<string, PaidBatch>(),
        allocations: new Map<string, Allocation>(),
      };
      states.set(row.orgId, state);
      if (row.type === 'free_grant') state.nonCash += row.quantity;
      else if (row.type === 'staff_adjustment') {
        if (row.quantity > 0) state.nonCash += row.quantity;
        else {
          let remaining = -row.quantity;
          const nonCash = Math.min(state.nonCash, remaining);
          state.nonCash -= nonCash;
          remaining -= nonCash;
          takePaid(state, remaining);
        }
      } else if (row.type === 'purchase' && row.purchaseId) {
        state.paid.set(row.purchaseId, {
          credits: row.quantity,
          priceMinor: row.unitPriceMinor ?? 0,
        });
      } else if (row.type === 'consumption') {
        let remaining = -row.quantity;
        const nonCash = Math.min(state.nonCash, remaining);
        state.nonCash -= nonCash;
        remaining -= nonCash;
        state.allocations.set(row.id, {
          nonCash,
          paid: takePaid(state, remaining),
        });
      } else if (row.type === 'failure_reversal' && row.sourceLedgerEntryId) {
        const allocation = state.allocations.get(row.sourceLedgerEntryId);
        if (!allocation) continue;
        state.nonCash += allocation.nonCash;
        for (const restored of allocation.paid) {
          const batch = state.paid.get(restored.purchaseId);
          if (batch) batch.credits += restored.credits;
        }
      } else if (
        ['refund_reversal', 'chargeback_reversal'].includes(row.type) &&
        row.purchaseId
      ) {
        const batch = state.paid.get(row.purchaseId);
        if (batch) batch.credits = Math.max(0, batch.credits + row.quantity);
      } else if (row.type === 'chargeback_reinstatement' && row.purchaseId) {
        const batch = state.paid.get(row.purchaseId);
        if (batch) batch.credits += row.quantity;
      }
    }

    let credits = 0;
    let minor = 0;
    for (const state of states.values())
      for (const batch of state.paid.values()) {
        credits += batch.credits;
        minor += batch.credits * batch.priceMinor;
      }
    return { credits, minor };
  }

  private async emitBacklogAlert(): Promise<void> {
    const health = await this.health();
    if (health.health.backlogAlert)
      this.alert('reconciliation_backlog', 'attention', {
        openFindings: health.health.openFindings,
        oldestFindingAgeMinutes: health.health.oldestFindingAgeMinutes,
      });
    if (health.health.provider.degraded)
      this.alert('paymob_error_rate', 'attention', {
        attempts: health.health.provider.attempts,
        errorRatePercent: health.health.provider.errorRatePercent,
      });
  }

  private fingerprintPart(value: unknown): string {
    return typeof value === 'string' || typeof value === 'number'
      ? String(value)
      : '';
  }

  private alert(
    alertCode: string,
    severity: 'attention' | 'critical',
    context: Record<string, unknown>,
  ): void {
    this.logger.warn(
      buildBackendLog(BillingObservabilityService.name, {
        action: 'standalone-billing-alert',
        outcome: 'failure',
        alertCode,
        severity,
        ...context,
      }),
    );
  }
}
