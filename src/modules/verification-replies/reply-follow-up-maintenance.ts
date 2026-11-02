import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { VerificationMessageDispatchesRepository } from '../../infrastructure/database/repositories/verification-message-dispatches.repository';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';

export const REPLY_FOLLOW_UP_MAINTENANCE_QUEUE = 'reply-follow-up-maintenance';
const SWEEP = 'expire-acknowledgment-leases';

@Injectable()
export class ReplyFollowUpMaintenanceScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReplyFollowUpMaintenanceScheduler.name);

  constructor(
    @InjectQueue(REPLY_FOLLOW_UP_MAINTENANCE_QUEUE)
    private readonly queue: Queue,
  ) {}

  onApplicationBootstrap(): void {
    void this.ensure();
  }

  async ensure(): Promise<void> {
    try {
      await this.queue.upsertJobScheduler(
        SWEEP,
        { every: 60_000 },
        {
          name: SWEEP,
          data: {},
          opts: {
            attempts: 1,
            removeOnComplete: { count: 100 },
            removeOnFail: { count: 100 },
          },
        },
      );
    } catch (error) {
      this.logger.error(
        buildBackendLog(ReplyFollowUpMaintenanceScheduler.name, {
          action: 'reply-follow-up-maintenance-schedule',
          outcome: 'failure',
          ...normalizeError(error),
        }),
      );
    }
  }
}

/** Runs even with sending disabled: unresolved billing must remain visible. */
@Processor(REPLY_FOLLOW_UP_MAINTENANCE_QUEUE, { concurrency: 1 })
@Injectable()
export class ReplyFollowUpMaintenanceProcessor extends WorkerHost {
  constructor(
    private readonly dispatches: VerificationMessageDispatchesRepository,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name === SWEEP) await this.dispatches.expireAcknowledgmentLeases();
  }
}
