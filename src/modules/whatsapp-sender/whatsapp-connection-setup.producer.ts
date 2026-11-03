import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { buildBackendLog } from '../../shared/logging/backend-log.util';
import {
  CONNECTION_SETUP_JOB,
  CONNECTION_HEALTH_JOB,
  CONNECTION_TEMPLATE_SYNC_JOB,
  CONNECTION_TEMPLATE_SYNC_WEBHOOK_DELAY_MS,
  WHATSAPP_CONNECTION_SETUP_QUEUE,
  type WhatsappConnectionSetupJobData,
} from './whatsapp-connection-setup-queue.constants';

/**
 * The connection row is the record of setup; a job only says "look now". So a
 * job is never retried by the queue (the sweep finds a due row again), and a
 * duplicate is harmless because a worker must claim the row first.
 */
export const CONNECTION_SETUP_JOB_OPTIONS = {
  attempts: 1,
  removeOnComplete: true,
  removeOnFail: { age: 7 * 24 * 60 * 60, count: 1000 },
};

/** Queues setup and template work. Never throws: callers carry on. */
@Injectable()
export class WhatsappConnectionSetupProducer {
  private readonly logger = new Logger(WhatsappConnectionSetupProducer.name);

  constructor(
    @InjectQueue(WHATSAPP_CONNECTION_SETUP_QUEUE)
    private readonly queue: Queue<WhatsappConnectionSetupJobData>,
  ) {}

  async requestHealth(
    orgId: string,
    connectionId: string,
    signupGeneration: number,
  ): Promise<boolean> {
    try {
      await this.queue.add(
        CONNECTION_HEALTH_JOB,
        { orgId, connectionId, signupGeneration },
        {
          ...CONNECTION_SETUP_JOB_OPTIONS,
          jobId: `wa-health-${connectionId}-${signupGeneration}-${Math.floor(Date.now() / 60_000)}`,
        },
      );
      return true;
    } catch (error) {
      this.logQueueFailure('whatsapp_health_enqueue', error);
      return false;
    }
  }

  /** True when queued. False is not an error: the sweep picks the row up. */
  async enqueueSetup(
    connectionId: string,
    signupGeneration: number,
    delayMs = 0,
  ): Promise<boolean> {
    try {
      await this.queue.add(
        CONNECTION_SETUP_JOB,
        { connectionId, signupGeneration },
        {
          ...CONNECTION_SETUP_JOB_OPTIONS,
          // Unique per request: a job still running holds its own id, and a
          // follow-up queued from inside it must not be dropped.
          jobId: `wa-setup-${connectionId}-${signupGeneration}-${Date.now()}`,
          ...(delayMs > 0 && { delay: delayMs }),
        },
      );
      return true;
    } catch (error) {
      this.logQueueFailure('whatsapp_connection_setup_enqueue', error);
      return false;
    }
  }

  /**
   * One template sync for the connection, a minute from now. A burst of
   * webhooks for the same account shares the job.
   */
  async requestTemplateSync(
    connectionId: string,
    delayMs = CONNECTION_TEMPLATE_SYNC_WEBHOOK_DELAY_MS,
  ): Promise<boolean> {
    try {
      await this.queue.add(
        CONNECTION_TEMPLATE_SYNC_JOB,
        { connectionId },
        {
          ...CONNECTION_SETUP_JOB_OPTIONS,
          jobId: `wa-template-sync-${connectionId}`,
          ...(delayMs > 0 && { delay: delayMs }),
        },
      );
      return true;
    } catch (error) {
      this.logQueueFailure('whatsapp_connection_template_sync_enqueue', error);
      return false;
    }
  }

  private logQueueFailure(action: string, error: unknown): void {
    this.logger.warn(
      buildBackendLog(WhatsappConnectionSetupProducer.name, {
        action,
        outcome: 'failure',
        errorName: error instanceof Error ? error.name : 'UnknownError',
        errorCode: 'queue_unavailable',
      }),
    );
  }
}
