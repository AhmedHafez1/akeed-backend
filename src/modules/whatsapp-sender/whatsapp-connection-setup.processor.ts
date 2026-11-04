import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Optional } from '@nestjs/common';
import { ConnectionHealthService } from './connection-health.service';
import type { Job } from 'bullmq';
import { WhatsappConnectionsRepository } from '../../infrastructure/database/repositories/whatsapp-connections.repository';
import { ConnectionSetupService } from './connection-setup.service';
import { ConnectionTemplatesService } from './connection-templates.service';
import {
  CONNECTION_SETUP_JOB,
  CONNECTION_HEALTH_JOB,
  CONNECTION_HEALTH_SWEEP_JOB,
  CONNECTION_SETUP_SWEEP_JOB,
  CONNECTION_TEMPLATE_SYNC_ALL_JOB,
  CONNECTION_TEMPLATE_SYNC_JOB,
  WHATSAPP_CONNECTION_SETUP_QUEUE,
  type ConnectionSetupJob,
  type ConnectionTemplateSyncJob,
  type WhatsappConnectionSetupJobData,
} from './whatsapp-connection-setup-queue.constants';
import { WhatsappConnectionSetupProducer } from './whatsapp-connection-setup.producer';

/**
 * A few accounts at once: each holds its own claim, and the pause between
 * template submissions keeps any one account's requests spread out.
 */
@Processor(WHATSAPP_CONNECTION_SETUP_QUEUE, { concurrency: 4 })
@Injectable()
export class WhatsappConnectionSetupProcessor extends WorkerHost {
  constructor(
    private readonly setup: ConnectionSetupService,
    private readonly templates: ConnectionTemplatesService,
    private readonly connections: WhatsappConnectionsRepository,
    private readonly producer: WhatsappConnectionSetupProducer,
    @Optional() private readonly health?: ConnectionHealthService,
  ) {
    super();
  }

  async process(job: Job<WhatsappConnectionSetupJobData>): Promise<void> {
    switch (job.name) {
      case CONNECTION_SETUP_JOB: {
        const data = job.data as ConnectionSetupJob;
        await this.setup.run(data.connectionId, data.signupGeneration);
        if (this.health) {
          const row = await this.connections.findById(data.connectionId);
          if (row)
            await this.producer.requestHealth(
              row.orgId,
              row.id,
              row.signupGeneration,
            );
        }
        return;
      }
      case CONNECTION_HEALTH_SWEEP_JOB:
        await this.health?.sweep();
        return;
      case CONNECTION_HEALTH_JOB: {
        const data = job.data as {
          orgId: string;
          connectionId: string;
          signupGeneration: number;
        };
        await this.health?.run(
          data.orgId,
          data.connectionId,
          data.signupGeneration,
        );
        return;
      }
      case CONNECTION_SETUP_SWEEP_JOB:
        await this.setup.sweep();
        return;
      case CONNECTION_TEMPLATE_SYNC_JOB:
        await this.templates.syncConnection(
          (job.data as ConnectionTemplateSyncJob).connectionId,
        );
        return;
      case CONNECTION_TEMPLATE_SYNC_ALL_JOB:
        for (const connection of await this.connections.findForTemplateSync())
          await this.producer.requestTemplateSync(connection.id, 0);
        return;
    }
  }
}
