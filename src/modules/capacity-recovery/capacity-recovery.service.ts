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
import { buildBackendLog } from '../../shared/logging/backend-log.util';
import { CAPACITY_RECOVERY_BATCH } from './capacity-recovery.constants';

type IntegrationRecord = typeof integrations.$inferSelect;

export interface CapacityRecoveryResult {
  /** Handed to the send path (sent now, or scheduled for quiet hours). */
  resumed: number;
  /** Too old to send; moved to the merchant's needs-action list. */
  stale: number;
  /** Left blocked: the source cannot send for another reason. */
  waiting: number;
  /** Another worker reopened it first. */
  raced: number;
  /** Capacity ran out during the run. */
  exhausted: boolean;
  /** The batch was full and capacity remains: run again. */
  more: boolean;
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
  ): Promise<CapacityRecoveryResult> {
    const { blockedOrderMaxAgeHours } = readUsageAlertsConfig(this.config);
    const result: CapacityRecoveryResult = {
      resumed: 0,
      stale: 0,
      waiting: 0,
      raced: 0,
      exhausted: false,
      more: false,
    };
    const candidates =
      await this.verificationsRepo.listCapacityRecoveryCandidates({
        orgId,
        reasons: CAPACITY_BLOCK_REASONS,
        legacyFailedSince: new Date(
          now.getTime() - blockedOrderMaxAgeHours * 3_600_000,
        ).toISOString(),
        limit: CAPACITY_RECOVERY_BATCH,
      });
    const sources = new Map(
      (await this.integrationsRepo.findActiveByOrg(orgId)).map(
        (source) => [source.id, source] as const,
      ),
    );

    for (const candidate of candidates) {
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
        if (moved) result.stale += 1;
        continue;
      }

      const source = candidate.integrationId
        ? sources.get(candidate.integrationId)
        : undefined;
      if (!source || !this.sourceCanSend(source)) {
        result.waiting += 1;
        continue;
      }

      const slot = await this.entitlements.hasAvailableSlot(source);
      if (!slot.available) {
        if (isCapacityBlockReason(slot.reason ?? 'plan_limit_reached')) {
          result.exhausted = true;
          break;
        }
        result.waiting += 1;
        continue;
      }

      const reopened =
        await this.verificationsRepo.reopenRetryableInitialFailure(
          candidate.verificationId,
          orgId,
        );
      if (!reopened) {
        result.raced += 1;
        continue;
      }

      await this.hub.resumeInitialSend(
        candidate.verificationId,
        { id: candidate.orderId, orgId },
        source,
      );
      result.resumed += 1;

      // The ledger is the last word on capacity: if the send was refused
      // anyway, the order is blocked again and so is every one after it.
      const after = await this.verificationsRepo.findById(
        candidate.verificationId,
      );
      if (after?.status === 'blocked') {
        result.resumed -= 1;
        result.exhausted = true;
        break;
      }
    }

    result.more =
      !result.exhausted && candidates.length === CAPACITY_RECOVERY_BATCH;
    this.logger.log(
      buildBackendLog(CapacityRecoveryService.name, {
        action: 'capacity-recovery-run',
        outcome: 'success',
        orgId,
        candidates: candidates.length,
        ...result,
      }),
    );
    await this.usageAlerts.evaluateOrg(orgId);
    return result;
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
