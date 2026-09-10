import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import {
  BILLING_RECONCILIATION_QUEUE,
  type BillingReconciliationJob,
} from './billing-reconciliation-queue.constants';
import { BillingObservabilityService } from './billing-observability.service';
import { BillingReconciliationProducer } from './billing-reconciliation.producer';
import { BillingObservabilityRepository } from './billing-observability.repository';

@Processor(BILLING_RECONCILIATION_QUEUE, { concurrency: 1 })
@Injectable()
export class BillingReconciliationProcessor extends WorkerHost {
  constructor(
    private readonly service: BillingObservabilityService,
    private readonly producer: BillingReconciliationProducer,
    private readonly repository: BillingObservabilityRepository,
  ) {
    super();
  }

  async process(job: Job<BillingReconciliationJob>): Promise<void> {
    let runId = job.data.runId;
    if (!runId) {
      const run = await this.repository.createRun({
        trigger: 'nightly',
        runKey: `nightly:${job.timestamp}`,
        mode: this.producer.mode(),
      });
      runId = run.id;
    }
    await this.service.processRun(runId);
  }
}
