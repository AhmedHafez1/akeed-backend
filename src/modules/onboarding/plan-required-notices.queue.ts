import { BullModule, InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import { PlanRequiredNoticesService } from './plan-required-notices.service';
import { buildBackendLog } from '../../shared/logging/backend-log.util';

export const PLAN_REQUIRED_QUEUE = 'plan-required-notices';
@Injectable()
export class PlanRequiredNoticesScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(PlanRequiredNoticesScheduler.name);
  constructor(
    @InjectQueue(PLAN_REQUIRED_QUEUE) private readonly queue: Queue,
  ) {}
  async onApplicationBootstrap() {
    try {
      await this.queue.upsertJobScheduler(
        'plan-required-notice-sweep',
        { every: 15_000 },
        {
          name: 'drain',
          data: {},
          opts: {
            attempts: 1,
            removeOnComplete: true,
            removeOnFail: { count: 100 },
          },
        },
      );
    } catch {
      this.logger.warn(
        buildBackendLog(PlanRequiredNoticesScheduler.name, {
          action: 'plan-required-notice-schedule',
          outcome: 'failure',
          reason: 'queue_unavailable',
        }),
      );
    }
  }
}
@Processor(PLAN_REQUIRED_QUEUE, { concurrency: 1 })
@Injectable()
export class PlanRequiredNoticesProcessor extends WorkerHost {
  constructor(private readonly notices: PlanRequiredNoticesService) {
    super();
  }
  async process() {
    await this.notices.drain();
  }
}
@Module({
  imports: [BullModule.registerQueue({ name: PLAN_REQUIRED_QUEUE })],
  exports: [BullModule],
})
export class PlanRequiredNoticesQueueModule {}
