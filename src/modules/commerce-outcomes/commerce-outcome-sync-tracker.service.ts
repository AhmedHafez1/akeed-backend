import { Injectable, Logger } from '@nestjs/common';
import {
  CommerceOutcomeSyncsRepository,
  type CommerceOutcomeSync,
  type CommerceOutcomeSyncTarget,
} from '../../infrastructure/database/repositories/commerce-outcome-syncs.repository';
import type {
  CommerceOutcomeDispatchCommand,
  CommerceOutcomeOperationResult,
} from '../../shared/commerce/commerce-outcome';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import { planOutcomeSync } from './commerce-outcome-sync.policy';
import { CommerceOutcomeSyncProducer } from './commerce-outcome-sync.producer';

function toTarget(
  command: CommerceOutcomeDispatchCommand,
  orderId: string,
): CommerceOutcomeSyncTarget {
  return {
    orgId: command.orgId,
    integrationId: command.integrationId,
    orderId,
    externalOrderId: command.externalOrderId,
    correlationId: command.correlationId,
    action: command.action,
  };
}

/**
 * Keeps the remote side of an outcome on record for adapters that track
 * synchronization, and schedules the next try when one is due.
 *
 * It only observes: a failure here is logged and never changes what the
 * dispatch answers, and the local verification result is not its to touch.
 */
@Injectable()
export class CommerceOutcomeSyncTracker {
  private readonly logger = new Logger(CommerceOutcomeSyncTracker.name);

  constructor(
    private readonly syncs: CommerceOutcomeSyncsRepository,
    private readonly producer: CommerceOutcomeSyncProducer,
  ) {}

  async begin(
    command: CommerceOutcomeDispatchCommand,
    orderId: string,
  ): Promise<CommerceOutcomeSync | undefined> {
    try {
      return await this.syncs.begin(
        toTarget(command, orderId),
        command.retryInBackground === true,
      );
    } catch (error) {
      this.logFailure('commerce-outcome-sync-begin', command, error);
      return undefined;
    }
  }

  /** Records a result reached without calling the adapter. */
  async recordWithoutAttempt(
    command: CommerceOutcomeDispatchCommand,
    orderId: string,
    result: CommerceOutcomeOperationResult,
  ): Promise<void> {
    try {
      if (result.status === 'unsupported') {
        await this.syncs.recordUnsupported(
          toTarget(command, orderId),
          result.reason,
        );
        return;
      }
      const sync = await this.syncs.begin(
        toTarget(command, orderId),
        command.retryInBackground === true,
      );
      await this.settle(sync, command, result);
    } catch (error) {
      this.logFailure('commerce-outcome-sync-record', command, error);
    }
  }

  async settle(
    sync: CommerceOutcomeSync | undefined,
    command: CommerceOutcomeDispatchCommand,
    result: CommerceOutcomeOperationResult,
  ): Promise<void> {
    if (!sync) return;
    try {
      const plan = planOutcomeSync(result, sync);
      const dueAt =
        plan.retryDelayMs === null ? null : Date.now() + plan.retryDelayMs;
      const settled = await this.syncs.settle(sync.id, sync.orgId, {
        state: plan.state,
        errorCode: plan.errorCode,
        providerStatus: plan.providerStatus,
        requiresAssistance: plan.requiresAssistance,
        spent: plan.spent,
        nextAttemptAt: dueAt === null ? null : new Date(dueAt).toISOString(),
      });
      if (!settled || plan.retryDelayMs === null || dueAt === null) return;
      try {
        await this.producer.scheduleRetry({
          syncId: settled.id,
          orgId: settled.orgId,
          attempts: settled.attempts,
          deferrals: settled.deferrals,
          dueAt,
          delayMs: plan.retryDelayMs,
        });
      } catch (error) {
        // Nothing would ever try again, so the row must not keep saying it
        // is waiting: it becomes a visible failure the merchant can retry.
        await this.syncs.failPending(
          settled.id,
          settled.orgId,
          'retry_not_scheduled',
        );
        this.logFailure('commerce-outcome-sync-schedule', command, error);
      }
    } catch (error) {
      this.logFailure('commerce-outcome-sync-settle', command, error);
    }
  }

  private logFailure(
    action: string,
    command: CommerceOutcomeDispatchCommand,
    error: unknown,
  ): void {
    this.logger.error(
      buildBackendLog(CommerceOutcomeSyncTracker.name, {
        action,
        outcome: 'failure',
        orgId: command.orgId,
        integrationId: command.integrationId,
        commerceAction: command.action,
        correlationId: command.correlationId,
        ...normalizeError(error),
      }),
    );
  }
}
