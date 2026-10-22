import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationsRepository } from '../../infrastructure/database/repositories/integrations.repository';
import { VerificationsRepository } from '../../infrastructure/database/repositories/verifications.repository';
import type { integrations } from '../../infrastructure/database/schema';
import { BillingEntitlementService } from '../verification-core/billing-entitlement.service';
import { VerificationHubService } from '../verification-core/verification-hub.service';
import { UsageAlertService } from '../verification-core/usage-alert.service';
import {
  CAPACITY_BLOCK_REASONS,
  CAPACITY_BLOCK_STALE_REASON,
  isBlockedOrderStale,
  isCapacityBlockReason,
} from '../../shared/verification/capacity-block';
import { readUsageAlertsConfig } from '../../shared/config/usage-alerts.config';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import {
  CAPACITY_RECOVERY_BATCH,
  CAPACITY_RECOVERY_PAGES_PER_RUN,
  CAPACITY_RESUME_GRACE_MS,
  type CapacityRecoveryCursor,
} from './capacity-recovery.constants';

type IntegrationRecord = typeof integrations.$inferSelect;
type Candidate = Awaited<
  ReturnType<VerificationsRepository['listCapacityRecoveryCandidates']>
>[number];
type CandidateOutcome =
  | 'resumed'
  | 'stale'
  | 'waiting'
  | 'raced'
  | 'unchanged'
  | 'exhausted';

export interface CapacityRecoveryResult {
  /** Handed to the send path (sent now, or scheduled for quiet hours). */
  resumed: number;
  /** Too old to send; moved to the merchant's needs-action list. */
  stale: number;
  /** Left blocked: the source cannot send for another reason. */
  waiting: number;
  /** Another worker reopened it first. */
  raced: number;
  /** Earlier handoffs that never reached the send path, blocked again. */
  returned: number;
  /** Capacity ran out during the run. */
  exhausted: boolean;
  /** The page budget ran out with capacity left: run again from `cursor`. */
  more: boolean;
  /** The last order looked at, where a follow-up run starts. */
  cursor: CapacityRecoveryCursor | null;
}

/**
 * Sends an org's blocked orders once capacity is back, oldest first.
 *
 * Every order is checked again just before it is sent, never trusted from the
 * list: its age, its source, the capacity left, and its status through the
 * reopen, which is one status-guarded update so only one worker can win it.
 * The send itself goes through the ordinary path (send delay, quiet hours)
 * and the dispatch ledger, which claims usage or a credit hold once per
 * message. Running this twice at once, or again after a retry, can therefore
 * neither send an order twice nor charge it twice.
 *
 * The reopen marks the order as handed over. If the send or the enqueue then
 * throws, the order is blocked again at once; if the process dies in between,
 * the next run blocks it again once the grace period has passed. Either way
 * it is not left pending with nothing to send it.
 *
 * Orders are read a page at a time past a cursor, so orders that must wait
 * (their source is paused) never hide newer ones that can be sent.
 */
@Injectable()
export class CapacityRecoveryService {
  private readonly logger = new Logger(CapacityRecoveryService.name);

  constructor(
    private readonly verificationsRepo: VerificationsRepository,
    private readonly integrationsRepo: IntegrationsRepository,
    private readonly entitlements: BillingEntitlementService,
    private readonly hub: VerificationHubService,
    private readonly usageAlerts: UsageAlertService,
    private readonly config: ConfigService,
  ) {}

  async recover(
    orgId: string,
    now = new Date(),
    after?: CapacityRecoveryCursor,
  ): Promise<CapacityRecoveryResult> {
    const { blockedOrderMaxAgeHours } = readUsageAlertsConfig(this.config);
    const result: CapacityRecoveryResult = {
      resumed: 0,
      stale: 0,
      waiting: 0,
      raced: 0,
      returned: 0,
      exhausted: false,
      more: false,
      cursor: after ?? null,
    };
    result.returned =
      await this.verificationsRepo.returnStrandedCapacityResumes({
        orgId,
        olderThan: new Date(
          now.getTime() - CAPACITY_RESUME_GRACE_MS,
        ).toISOString(),
      });
    const legacyFailedSince = new Date(
      now.getTime() - blockedOrderMaxAgeHours * 3_600_000,
    ).toISOString();
    const sources = new Map(
      (await this.integrationsRepo.findActiveByOrg(orgId)).map(
        (source) => [source.id, source] as const,
      ),
    );

    let candidates = 0;
    pages: for (let page = 0; page < CAPACITY_RECOVERY_PAGES_PER_RUN; page++) {
      const batch = await this.verificationsRepo.listCapacityRecoveryCandidates(
        {
          orgId,
          reasons: CAPACITY_BLOCK_REASONS,
          legacyFailedSince,
          limit: CAPACITY_RECOVERY_BATCH,
          ...(result.cursor ? { after: result.cursor } : {}),
        },
      );
      candidates += batch.length;
      for (const candidate of batch) {
        // A row without a creation time sorts last and cannot be paged past;
        // the cursor stays on the last row that has one.
        if (candidate.createdAt) {
          result.cursor = {
            createdAt: candidate.createdAt,
            id: candidate.verificationId,
          };
        }
        const outcome = await this.recoverOne(
          candidate,
          orgId,
          sources,
          blockedOrderMaxAgeHours,
          now,
        );
        if (outcome === 'exhausted') {
          result.exhausted = true;
          break pages;
        }
        if (outcome !== 'unchanged') result[outcome] += 1;
      }
      if (batch.length < CAPACITY_RECOVERY_BATCH) break;
      if (page === CAPACITY_RECOVERY_PAGES_PER_RUN - 1) result.more = true;
    }

    this.logger.log(
      buildBackendLog(CapacityRecoveryService.name, {
        action: 'capacity-recovery-run',
        outcome: 'success',
        orgId,
        candidates,
        resumed: result.resumed,
        stale: result.stale,
        waiting: result.waiting,
        raced: result.raced,
        returned: result.returned,
        exhausted: result.exhausted,
        more: result.more,
      }),
    );
    await this.usageAlerts.evaluateOrg(orgId);
    return result;
  }

  private async recoverOne(
    candidate: Candidate,
    orgId: string,
    sources: Map<string, IntegrationRecord>,
    blockedOrderMaxAgeHours: number,
    now: Date,
  ): Promise<CandidateOutcome> {
    if (
      isBlockedOrderStale(
        candidate.orderCreatedAt,
        blockedOrderMaxAgeHours,
        now,
      )
    ) {
      const moved = await this.verificationsRepo.markCapacityBlockUnsent({
        verificationId: candidate.verificationId,
        orgId,
        reason: CAPACITY_BLOCK_STALE_REASON,
        blockedReason: candidate.reason,
      });
      return moved ? 'stale' : 'unchanged';
    }

    const source = candidate.integrationId
      ? sources.get(candidate.integrationId)
      : undefined;
    if (!source || !this.sourceCanSend(source)) return 'waiting';

    const slot = await this.entitlements.hasAvailableSlot(source);
    if (!slot.available) {
      return isCapacityBlockReason(slot.reason ?? 'plan_limit_reached')
        ? 'exhausted'
        : 'waiting';
    }

    const reopened = await this.verificationsRepo.reopenRetryableInitialFailure(
      candidate.verificationId,
      orgId,
      { capacityResume: true },
    );
    if (!reopened) return 'raced';

    try {
      await this.hub.resumeInitialSend(
        candidate.verificationId,
        { id: candidate.orderId, orgId },
        source,
      );
    } catch (error) {
      await this.returnAfterFailedHandoff(candidate.verificationId, orgId);
      this.logger.warn(
        buildBackendLog(CapacityRecoveryService.name, {
          action: 'capacity-recovery-handoff',
          outcome: 'failure',
          orgId,
          verificationId: candidate.verificationId,
          ...normalizeError(error),
        }),
      );
      // The job is retried; the order is blocked again and waits for it.
      throw error;
    }

    // The ledger is the last word on capacity: if the send was refused
    // anyway, the order is blocked again and so is every one after it.
    const after = await this.verificationsRepo.findById(
      candidate.verificationId,
    );
    return after?.status === 'blocked' ? 'exhausted' : 'resumed';
  }

  /**
   * Blocks the order again right away. A send scheduled before the failure
   * (its time set after now) is left alone: its job will send it.
   */
  private async returnAfterFailedHandoff(
    verificationId: string,
    orgId: string,
  ): Promise<void> {
    try {
      await this.verificationsRepo.returnStrandedCapacityResumes({
        orgId,
        verificationId,
        olderThan: new Date(Date.now() + 1_000).toISOString(),
      });
    } catch (error) {
      // The next run past the grace period blocks it again.
      this.logger.warn(
        buildBackendLog(CapacityRecoveryService.name, {
          action: 'capacity-recovery-return',
          outcome: 'failure',
          orgId,
          verificationId,
          ...normalizeError(error),
        }),
      );
    }
  }

  /**
   * A source that cannot send for a reason other than capacity (removed,
   * paused, unpaid subscription) keeps its orders blocked; they are sent if
   * the merchant fixes it in time, or age out to the needs-action list.
   */
  private sourceCanSend(source: IntegrationRecord): boolean {
    return (
      source.isActive === true &&
      source.isAutoVerifyEnabled === true &&
      source.onboardingStatus === 'completed' &&
      this.entitlements.evaluateAccess(source).reason === null
    );
  }
}
