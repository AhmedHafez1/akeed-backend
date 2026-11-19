import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { readAnnouncementEmailConfig } from '../../shared/config/announcement-email.config';
import { buildBackendLog } from '../../shared/logging/backend-log.util';
import { AnnouncementEmailService } from './announcement-email.service';

export const ANNOUNCEMENT_EMAIL_QUEUE = 'announcement-email';
@Injectable()
export class AnnouncementEmailScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(AnnouncementEmailScheduler.name);
  constructor(
    @InjectQueue(ANNOUNCEMENT_EMAIL_QUEUE) private readonly queue: Queue,
    private readonly config: ConfigService,
  ) {}
  onApplicationBootstrap(): void {
    void this.ensure();
  }
  async ensure(): Promise<void> {
    const settings = readAnnouncementEmailConfig(this.config);
    try {
      if (settings.enabled)
        await this.queue.upsertJobScheduler(
          'announcement-email-sweep',
          { every: settings.intervalMs },
          {
            name: 'sweep',
            data: {},
            opts: {
              attempts: 1,
              removeOnComplete: { age: 86400, count: 200 },
              removeOnFail: { age: 604800, count: 1000 },
            },
          },
        );
      else await this.queue.removeJobScheduler('announcement-email-sweep');
    } catch {
      this.logger.error(
        buildBackendLog(AnnouncementEmailScheduler.name, {
          action: 'announcement-email-scheduler',
          outcome: 'failure',
          errorCode: 'queue_unavailable',
        }),
      );
    }
  }
}
@Processor(ANNOUNCEMENT_EMAIL_QUEUE, { concurrency: 1 })
@Injectable()
export class AnnouncementEmailProcessor extends WorkerHost {
  constructor(private readonly announcements: AnnouncementEmailService) {
    super();
  }
  async process(): Promise<void> {
    await this.announcements.sendBatch();
  }
}
