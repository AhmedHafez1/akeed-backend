import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import {
  parseStandaloneBillingObservabilityConfig,
  STANDALONE_BILLING_OBSERVABILITY_CONFIG,
} from '../../shared/config/standalone-billing-observability.config';
import { DEFAULT_QUEUE_JOB_OPTIONS } from '../../shared/queue/job-options';
import {
  BILLING_RECONCILIATION_JOB,
  BILLING_RECONCILIATION_SCHEDULER,
  type BillingReconciliationJob,
} from './billing-reconciliation-queue.constants';
import { BillingReconciliationProcessor } from './billing-reconciliation.processor';
import { BillingReconciliationProducer } from './billing-reconciliation.producer';

function setup(environment: Record<string, string> = {}) {
  const queue = {
    upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
    add: jest.fn().mockResolvedValue(undefined),
  };
  const repository = {
    createRun: jest.fn((input: { runKey: string; mode: string }) =>
      Promise.resolve({
        id: `run-for-${input.runKey}`,
        status: 'queued',
        mode: input.mode,
      }),
    ),
  };
  const config = new ConfigService({
    [STANDALONE_BILLING_OBSERVABILITY_CONFIG]:
      parseStandaloneBillingObservabilityConfig(environment),
  });
  const producer = new BillingReconciliationProducer(
    queue as never,
    repository as never,
    config,
  );
  return { queue, repository, producer };
}

describe('BillingReconciliationProducer', () => {
  afterEach(() => jest.restoreAllMocks());

  it('registers one nightly scheduler at 02:30 Cairo with the shared retry policy', async () => {
    const { queue, producer } = setup();
    producer.onApplicationBootstrap();
    await new Promise(setImmediate);
    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      BILLING_RECONCILIATION_SCHEDULER,
      { pattern: '30 2 * * *', tz: 'Africa/Cairo' },
      {
        name: BILLING_RECONCILIATION_JOB,
        data: { trigger: 'nightly' },
        opts: DEFAULT_QUEUE_JOB_OPTIONS,
      },
    );
  });

  it('honours a configured schedule', async () => {
    const { queue, producer } = setup({
      STANDALONE_BILLING_RECONCILIATION_CRON: '0 4 * * *',
      STANDALONE_BILLING_RECONCILIATION_TIMEZONE: 'UTC',
    });
    producer.onApplicationBootstrap();
    await new Promise(setImmediate);
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      BILLING_RECONCILIATION_SCHEDULER,
      { pattern: '0 4 * * *', tz: 'UTC' },
      expect.anything(),
    );
  });

  it('logs, without throwing or leaking the error, when Redis is unavailable', async () => {
    const { queue, producer } = setup();
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    queue.upsertJobScheduler.mockRejectedValueOnce(
      new Error('connect ECONNREFUSED redis://user:secret@host'),
    );
    producer.onApplicationBootstrap();
    await new Promise(setImmediate);
    const [line] = error.mock.calls[0] as [string];
    expect(JSON.parse(line)).toMatchObject({
      action: 'billing-reconciliation-schedule',
      outcome: 'failure',
      errorCode: 'queue_unavailable',
    });
    expect(line).not.toContain('secret');
  });

  it('enqueues one job per durable run under a stable job id', async () => {
    const { queue, repository, producer } = setup();
    const run = await producer.enqueue({
      trigger: 'settlement',
      settlementId: 'settlement-1',
      triggeredBy: 'staff-1',
      reason: 'Record settlement',
      runKey: 'settlement:settlement-1',
    });
    expect(repository.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runKey: 'settlement:settlement-1',
        trigger: 'settlement',
        mode: 'local_only',
      }),
    );
    expect(queue.add).toHaveBeenCalledWith(
      BILLING_RECONCILIATION_JOB,
      {
        runId: run.id,
        trigger: 'settlement',
        settlementId: 'settlement-1',
      },
      {
        jobId: `billing-reconciliation-${run.id}`,
        ...DEFAULT_QUEUE_JOB_OPTIONS,
      },
    );
  });

  it.each([
    [{}, 'local_only'],
    [{ STANDALONE_BILLING_SCHEDULED_INQUIRY_ENABLED: 'true' }, 'report_only'],
    [
      {
        STANDALONE_BILLING_SCHEDULED_INQUIRY_ENABLED: 'true',
        STANDALONE_BILLING_RECONCILIATION_REPORT_ONLY: 'false',
      },
      'active',
    ],
  ])('derives the run mode from %o', (environment, mode) => {
    expect(setup(environment).producer.mode()).toBe(mode);
  });
});

describe('BillingReconciliationProcessor', () => {
  function processor() {
    const { repository, producer } = setup();
    const service = { processRun: jest.fn().mockResolvedValue(undefined) };
    return {
      repository,
      service,
      worker: new BillingReconciliationProcessor(
        service as never,
        producer,
        repository as never,
      ),
    };
  }

  it('continues the durable run a manual or settlement job names', async () => {
    const { repository, service, worker } = processor();
    await worker.process({
      data: { runId: 'run-1', trigger: 'manual' },
      timestamp: 1,
    } as Job<BillingReconciliationJob>);
    expect(repository.createRun).not.toHaveBeenCalled();
    expect(service.processRun).toHaveBeenCalledWith('run-1');
  });

  it('keys a nightly run to its job so every retry continues the same run', async () => {
    const { repository, service, worker } = processor();
    const job = {
      data: { trigger: 'nightly' },
      timestamp: 1_789_000_000_000,
    } as Job<BillingReconciliationJob>;
    await worker.process(job);
    await worker.process(job);
    expect(repository.createRun).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ runKey: 'nightly:1789000000000' }),
    );
    expect(repository.createRun).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ runKey: 'nightly:1789000000000' }),
    );
    expect(service.processRun.mock.calls).toEqual([
      ['run-for-nightly:1789000000000'],
      ['run-for-nightly:1789000000000'],
    ]);
  });

  it('rethrows a failed run so BullMQ retries it', async () => {
    const { service, worker } = processor();
    service.processRun.mockRejectedValueOnce(new Error('database down'));
    await expect(
      worker.process({
        data: { runId: 'run-1', trigger: 'manual' },
        timestamp: 1,
      } as Job<BillingReconciliationJob>),
    ).rejects.toThrow('database down');
  });
});
