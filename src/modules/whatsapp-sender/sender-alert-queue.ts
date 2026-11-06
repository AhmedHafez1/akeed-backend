import { BullModule, InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  Module,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { Queue, type Job } from 'bullmq';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import { WhatsappSenderAlertsRepository } from '../../infrastructure/database/repositories/whatsapp-sender-alerts.repository';
import { SenderAlertService } from './sender-alert.service';

export const SENDER_ALERT_QUEUE = 'whatsapp-sender-alerts';
export interface SenderAlertJob {
  orgId: string;
  signupGeneration?: number;
}
const OPTIONS = {
  attempts: 1,
  removeOnComplete: true,
  removeOnFail: { age: 86400, count: 1000 },
};

@Injectable()
export class SenderAlertProducer implements OnApplicationBootstrap {
  private readonly logger = new Logger(SenderAlertProducer.name);
  constructor(@InjectQueue(SENDER_ALERT_QUEUE) private readonly queue: Queue) {}

  onApplicationBootstrap() {
    void this.schedule();
  }
  async schedule(): Promise<void> {
    try {
      await this.queue.upsertJobScheduler(
        'sender-alert-sweep',
        { every: 120_000 },
        { name: 'sweep', data: {}, opts: OPTIONS },
      );
    } catch (error) {
      this.log(error);
    }
  }
  /** Scheduling is detached from customer sends; the database sweep repairs a missed enqueue. */
  request(orgId: string, signupGeneration?: number): void {
    try {
      void this.queue
        .add(
          'evaluate',
          { orgId, signupGeneration },
          {
            ...OPTIONS,
            // A retained failed job must not suppress the next reconciliation sweep.
            jobId: `wa-alert-${orgId}-${signupGeneration ?? 'current'}-${Math.floor(Date.now() / 60_000)}`,
          },
        )
        .catch((error) => this.log(error));
    } catch (error) {
      this.log(error);
    }
  }
  private log(error: unknown) {
    this.logger.warn(
      buildBackendLog(SenderAlertProducer.name, {
        action: 'sender-alert-enqueue',
        outcome: 'failure',
        ...normalizeError(error),
      }),
    );
  }
}

@Module({
  imports: [BullModule.registerQueue({ name: SENDER_ALERT_QUEUE })],
  providers: [SenderAlertProducer],
  exports: [SenderAlertProducer, BullModule],
})
export class SenderAlertQueueModule {}

@Processor(SENDER_ALERT_QUEUE, { concurrency: 4 })
@Injectable()
export class SenderAlertProcessor extends WorkerHost {
  constructor(
    private readonly service: SenderAlertService,
    private readonly alerts: WhatsappSenderAlertsRepository,
    private readonly producer: SenderAlertProducer,
    @InjectQueue(SENDER_ALERT_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }
  async process(job: Job<SenderAlertJob | { after?: string }>): Promise<void> {
    if (job.name === 'evaluate') {
      const data = job.data as SenderAlertJob;
      await this.service.evaluate(data.orgId, data.signupGeneration);
    } else if (job.name === 'sweep') {
      // Each page is a separate job so a large tenant population cannot monopolize a worker.
      const page = await this.alerts.listConnections(
        (job.data as { after?: string }).after,
      );
      for (const row of page)
        this.producer.request(row.orgId, row.signupGeneration);
      if (page.length === 50) await this.enqueuePage(page[49].id);
    }
  }
  private async enqueuePage(after: string) {
    await this.queue.add('sweep', { after }, OPTIONS);
  }
}
