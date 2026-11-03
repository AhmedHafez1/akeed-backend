import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Queue } from 'bullmq';
import { buildBackendLog } from '../../shared/logging/backend-log.util';
import {
  CONNECTION_SETUP_SWEEP_EVERY_MS,
  CONNECTION_SETUP_SWEEP_JOB,
  CONNECTION_SETUP_SWEEP_SCHEDULER,
  CONNECTION_TEMPLATE_SYNC_ALL_JOB,
  CONNECTION_TEMPLATE_SYNC_EVERY_MS,
  CONNECTION_TEMPLATE_SYNC_SCHEDULER,
  WHATSAPP_CONNECTION_SETUP_QUEUE,
  type WhatsappConnectionSetupJobData,
} from './whatsapp-connection-setup-queue.constants';
import { CONNECTION_SETUP_JOB_OPTIONS } from './whatsapp-connection-setup.producer';

/**
 * The sweep that finds due setups and the 6-hour template sync. Both run
 * whatever the own-number switches say: a connection that exists keeps
 * getting set up and kept in step, and sending stays the kill switch's.
 * With no connections, each run reads one indexed query and stops.
 */
@Injectable()
export class WhatsappConnectionSetupScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(WhatsappConnectionSetupScheduler.name);

  constructor(
    @InjectQueue(WHATSAPP_CONNECTION_SETUP_QUEUE)
    private readonly queue: Queue<WhatsappConnectionSetupJobData>,
  ) {}

  onApplicationBootstrap(): void {
    void this.schedule();
  }

  async schedule(): Promise<void> {
    try {
      await this.queue.upsertJobScheduler(
        CONNECTION_SETUP_SWEEP_SCHEDULER,
        { every: CONNECTION_SETUP_SWEEP_EVERY_MS },
        {
          name: CONNECTION_SETUP_SWEEP_JOB,
          data: {},
          opts: CONNECTION_SETUP_JOB_OPTIONS,
        },
      );
      await this.queue.upsertJobScheduler(
        CONNECTION_TEMPLATE_SYNC_SCHEDULER,
        { every: CONNECTION_TEMPLATE_SYNC_EVERY_MS },
        {
          name: CONNECTION_TEMPLATE_SYNC_ALL_JOB,
          data: {},
          opts: CONNECTION_SETUP_JOB_OPTIONS,
        },
      );
    } catch (error) {
      this.logger.error(
        buildBackendLog(WhatsappConnectionSetupScheduler.name, {
          action: 'whatsapp_connection_setup_schedule',
          outcome: 'failure',
          errorName: error instanceof Error ? error.name : 'UnknownError',
          errorCode: 'queue_unavailable',
        }),
      );
    }
  }
}
