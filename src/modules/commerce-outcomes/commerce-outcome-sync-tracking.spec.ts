import type { Job } from 'bullmq';
import type { OrdersRepository } from '../../infrastructure/database/repositories/orders.repository';
import type {
  CommerceOutcomeSync,
  CommerceOutcomeSyncSettlement,
  CommerceOutcomeSyncsRepository,
  CommerceOutcomeSyncTarget,
} from '../../infrastructure/database/repositories/commerce-outcome-syncs.repository';
import type {
  CommerceOutcomeAction,
  CommerceOutcomeAdapter,
  CommerceOutcomeDispatchCommand,
  CommerceOutcomeOperationResult,
} from '../../shared/commerce/commerce-outcome';
import { CommerceOutcomeRegistryService } from './commerce-outcome-registry.service';
import { CommerceOutcomeSyncTracker } from './commerce-outcome-sync-tracker.service';
import type { CommerceOutcomeSyncJobPayload } from './commerce-outcome-sync.constants';
import { outcomeSyncBackoffMs } from './commerce-outcome-sync.policy';
import { CommerceOutcomeSyncProcessor } from './commerce-outcome-sync.processor';
import type {
  CommerceOutcomeSyncProducer,
  OutcomeSyncRetry,
} from './commerce-outcome-sync.producer';

const command: CommerceOutcomeDispatchCommand = {
  orgId: 'org-1',
  integrationId: 'integration-1',
  externalOrderId: 'external-1',
  action: 'customer_confirmation',
  correlationId: 'verification-1',
  retryInBackground: true,
};

/** An in-memory stand-in with the repository's own semantics. */
class FakeSyncs {
  rows: CommerceOutcomeSync[] = [];

  private find(target: CommerceOutcomeSyncTarget) {
    return this.rows.find(
      (row) =>
        row.integrationId === target.integrationId &&
        row.orderId === target.orderId &&
        row.action === target.action,
    );
  }

  begin = jest.fn(
    (target: CommerceOutcomeSyncTarget, retryInBackground: boolean) => {
      let row = this.find(target);
      if (!row) {
        row = {
          id: `sync-${this.rows.length + 1}`,
          ...target,
          state: 'pending',
          attempts: 0,
          deferrals: 0,
          retryInBackground,
          requiresAssistance: false,
          providerStatus: null,
          errorCode: null,
          nextAttemptAt: null,
          createdAt: 'now',
          updatedAt: 'now',
        };
        this.rows.push(row);
      }
      Object.assign(row, {
        state: 'pending',
        retryInBackground,
        errorCode: null,
        requiresAssistance: false,
      });
      return Promise.resolve({ ...row });
    },
  );

  recordUnsupported = jest.fn(
    async (target: CommerceOutcomeSyncTarget, reason: string) => {
      await this.begin(target, false);
      Object.assign(this.find(target)!, {
        state: 'unsupported',
        errorCode: reason,
      });
    },
  );

  settle = jest.fn(
    (id: string, orgId: string, settlement: CommerceOutcomeSyncSettlement) => {
      const row = this.rows.find(
        (candidate) => candidate.id === id && candidate.orgId === orgId,
      );
      if (!row) return Promise.resolve(undefined);
      const { spent, ...values } = settlement;
      Object.assign(row, values);
      if (spent === 'attempt') row.attempts += 1;
      else row.deferrals += 1;
      return Promise.resolve({ ...row });
    },
  );

  failPending = jest.fn((id: string, orgId: string, errorCode: string) => {
    const row = this.rows.find(
      (candidate) => candidate.id === id && candidate.orgId === orgId,
    );
    if (row?.state === 'pending')
      Object.assign(row, { state: 'failed', errorCode });
    return Promise.resolve();
  });

  findByIdForOrg = jest.fn((id: string, orgId: string) =>
    Promise.resolve(
      this.rows.find(
        (candidate) => candidate.id === id && candidate.orgId === orgId,
      ),
    ),
  );
}

function buildOrder(integration: Record<string, unknown> = {}) {
  return {
    id: 'local-order-1',
    orgId: command.orgId,
    integrationId: command.integrationId,
    externalOrderId: command.externalOrderId,
    isTest: false,
    integration: {
      id: command.integrationId,
      orgId: command.orgId,
      platformType: 'easyorders',
      platformStoreUrl: 'easyorders:org-1',
      accessToken: null,
      isActive: true,
      metadata: {},
      ...integration,
    },
  };
}

function setup(
  options: {
    tracks?: boolean;
    capabilities?: CommerceOutcomeAction[];
    results?: Array<CommerceOutcomeOperationResult | Error>;
    integration?: Record<string, unknown>;
  } = {},
) {
  const syncs = new FakeSyncs();
  const scheduled: OutcomeSyncRetry[] = [];
  const producer = {
    scheduleRetry: jest.fn((retry: OutcomeSyncRetry) => {
      scheduled.push(retry);
      return Promise.resolve();
    }),
  };
  const results = [...(options.results ?? [{ status: 'applied' as const }])];
  const execute = jest.fn(() => {
    const next = results.length > 1 ? results.shift()! : results[0];
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  const adapter: CommerceOutcomeAdapter = {
    platformType: 'easyorders',
    requiresActiveConnection: true,
    capabilities: new Set(options.capabilities ?? [command.action]),
    ...(options.tracks === false ? {} : { tracksSynchronization: true }),
    execute,
  };
  const findForOutcomeDispatch = jest
    .fn()
    .mockResolvedValue(buildOrder(options.integration));
  const registry = new CommerceOutcomeRegistryService(
    { findForOutcomeDispatch } as unknown as OrdersRepository,
    [adapter],
    new CommerceOutcomeSyncTracker(
      syncs as unknown as CommerceOutcomeSyncsRepository,
      producer as unknown as CommerceOutcomeSyncProducer,
    ),
  );
  const processor = new CommerceOutcomeSyncProcessor(
    syncs as unknown as CommerceOutcomeSyncsRepository,
    registry,
  );
  const runJob = (syncId = 'sync-1', orgId = command.orgId) =>
    processor.process({
      id: 'job-1',
      data: { syncId, orgId },
    } as Job<CommerceOutcomeSyncJobPayload>);
  return {
    syncs,
    producer,
    scheduled,
    execute,
    registry,
    runJob,
    findForOutcomeDispatch,
  };
}

describe('commerce outcome synchronization tracking', () => {
  it('leaves an adapter that does not track exactly as it was', async () => {
    const { registry, syncs, producer, execute } = setup({
      tracks: false,
      results: [
        { status: 'retryable_failure', errorCode: 'source_unavailable' },
      ],
    });

    await expect(registry.dispatch(command)).resolves.toMatchObject({
      status: 'retryable_failure',
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(syncs.begin).not.toHaveBeenCalled();
    expect(syncs.rows).toHaveLength(0);
    expect(producer.scheduleRetry).not.toHaveBeenCalled();
  });

  it('records a confirmed result against the order and its source', async () => {
    const { registry, syncs } = setup();

    await registry.dispatch(command);

    expect(syncs.rows).toEqual([
      expect.objectContaining({
        orgId: 'org-1',
        integrationId: 'integration-1',
        orderId: 'local-order-1',
        externalOrderId: 'external-1',
        correlationId: 'verification-1',
        action: 'customer_confirmation',
        state: 'succeeded',
        attempts: 1,
      }),
    ]);
  });

  it('is pending while the adapter runs, so a lost answer leaves a trace', async () => {
    const { registry, syncs, execute } = setup();
    execute.mockImplementationOnce(() => {
      expect(syncs.rows[0]).toMatchObject({ state: 'pending', attempts: 0 });
      return Promise.resolve({ status: 'applied' });
    });

    await registry.dispatch(command);

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('records an unsupported action without calling the adapter', async () => {
    const { registry, syncs, execute, producer } = setup({
      capabilities: ['customer_confirmation'],
    });

    await expect(
      registry.dispatch({ ...command, action: 'automatic_no_reply_tagging' }),
    ).resolves.toMatchObject({
      status: 'unsupported',
      reason: 'capability_not_supported',
    });

    expect(execute).not.toHaveBeenCalled();
    expect(producer.scheduleRetry).not.toHaveBeenCalled();
    expect(syncs.rows[0]).toMatchObject({
      action: 'automatic_no_reply_tagging',
      state: 'unsupported',
      errorCode: 'capability_not_supported',
    });
  });

  it('records an inactive source as a failure', async () => {
    const { registry, syncs, execute } = setup({
      integration: { isActive: false },
    });

    await registry.dispatch(command);

    expect(execute).not.toHaveBeenCalled();
    expect(syncs.rows[0]).toMatchObject({
      state: 'failed',
      errorCode: 'integration_inactive',
    });
  });

  it('never tracks a synthetic order', async () => {
    const { registry, syncs, findForOutcomeDispatch } = setup();
    findForOutcomeDispatch.mockResolvedValue({ ...buildOrder(), isTest: true });

    await expect(registry.dispatch(command)).resolves.toMatchObject({
      status: 'applied',
    });
    expect(syncs.rows).toHaveLength(0);
  });

  it('keeps a transient failure pending and schedules one retry', async () => {
    const { registry, syncs, scheduled } = setup({
      results: [
        { status: 'retryable_failure', errorCode: 'source_unavailable' },
      ],
    });

    await registry.dispatch(command);

    expect(syncs.rows[0]).toMatchObject({
      state: 'pending',
      errorCode: 'source_unavailable',
      attempts: 1,
    });
    expect(scheduled).toEqual([
      {
        syncId: 'sync-1',
        orgId: 'org-1',
        attempts: 1,
        deferrals: 0,
        dueAt: Date.parse(syncs.rows[0].nextAttemptAt!),
        delayMs: outcomeSyncBackoffMs(1),
      },
    ]);
  });

  it('treats an adapter that throws as a transient failure', async () => {
    const { registry, syncs, scheduled } = setup({
      results: [new Error('socket hang up')],
    });

    await expect(registry.dispatch(command)).resolves.toMatchObject({
      status: 'retryable_failure',
      errorCode: 'adapter_execution_failed',
    });
    expect(syncs.rows[0]).toMatchObject({ state: 'pending', attempts: 1 });
    expect(scheduled).toHaveLength(1);
  });

  it('does not retry a merchant action behind the merchant', async () => {
    const { registry, syncs, producer } = setup({
      capabilities: ['merchant_no_reply_cancellation'],
      results: [
        { status: 'retryable_failure', errorCode: 'source_unavailable' },
      ],
    });

    await registry.dispatch({
      ...command,
      action: 'merchant_no_reply_cancellation',
      retryInBackground: undefined,
    });

    expect(syncs.rows[0]).toMatchObject({ state: 'failed' });
    expect(producer.scheduleRetry).not.toHaveBeenCalled();
  });

  it('stops at a credential failure and flags assisted action', async () => {
    const { registry, syncs, producer } = setup({
      results: [
        {
          status: 'permanent_failure',
          errorCode: 'credentials_rejected',
          requiresAssistance: true,
        },
      ],
    });

    await registry.dispatch(command);

    expect(syncs.rows[0]).toMatchObject({
      state: 'failed',
      errorCode: 'credentials_rejected',
      requiresAssistance: true,
    });
    expect(producer.scheduleRetry).not.toHaveBeenCalled();
  });

  it('retries through the worker until the store takes the outcome', async () => {
    const { registry, syncs, scheduled, execute, runJob } = setup({
      results: [
        {
          status: 'retryable_failure',
          errorCode: 'source_rate_limited',
          retryAfterMs: 20_000,
        },
        { status: 'retryable_failure', errorCode: 'write_unconfirmed' },
        { status: 'applied' },
      ],
    });

    await registry.dispatch(command);
    expect(scheduled[0]).toMatchObject({
      attempts: 0,
      deferrals: 1,
      delayMs: 20_000,
    });
    await runJob();
    expect(scheduled[1]).toMatchObject({ attempts: 1, deferrals: 1 });
    await runJob();

    expect(execute).toHaveBeenCalledTimes(3);
    expect(scheduled).toHaveLength(2);
    expect(syncs.rows).toHaveLength(1);
    expect(syncs.rows[0]).toMatchObject({
      state: 'succeeded',
      attempts: 2,
      deferrals: 1,
      errorCode: null,
    });
  });

  it('gives up after the last attempt and leaves a visible failure', async () => {
    const { registry, syncs, scheduled, execute, runJob } = setup({
      results: [
        { status: 'retryable_failure', errorCode: 'source_unavailable' },
      ],
    });

    await registry.dispatch(command);
    for (let run = 0; run < 10; run += 1) await runJob();

    expect(execute).toHaveBeenCalledTimes(5);
    expect(scheduled).toHaveLength(4);
    expect(syncs.rows[0]).toMatchObject({
      state: 'failed',
      errorCode: 'source_unavailable',
      attempts: 5,
    });
  });

  it('does nothing for a job whose row is no longer waiting', async () => {
    const { registry, execute, runJob } = setup();

    await registry.dispatch(command);
    await runJob();
    await runJob('sync-unknown');
    await runJob('sync-1', 'another-org');

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('closes a waiting row whose order no longer matches its source', async () => {
    const { registry, syncs, runJob, findForOutcomeDispatch, execute } = setup({
      results: [
        { status: 'retryable_failure', errorCode: 'source_unavailable' },
      ],
    });
    await registry.dispatch(command);
    findForOutcomeDispatch.mockResolvedValue(undefined);

    await runJob();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(syncs.rows[0]).toMatchObject({
      state: 'failed',
      errorCode: 'source_identity_mismatch',
    });
  });

  it('turns a retry that could not be scheduled into a visible failure', async () => {
    const { registry, syncs, producer } = setup({
      results: [
        { status: 'retryable_failure', errorCode: 'source_unavailable' },
      ],
    });
    producer.scheduleRetry.mockRejectedValueOnce(new Error('redis down'));

    await expect(registry.dispatch(command)).resolves.toMatchObject({
      status: 'retryable_failure',
    });
    expect(syncs.rows[0]).toMatchObject({
      state: 'failed',
      errorCode: 'retry_not_scheduled',
    });
  });

  it('answers the dispatch even when the sync state cannot be written', async () => {
    const { registry, syncs, execute } = setup();
    syncs.begin.mockRejectedValueOnce(new Error('db down'));

    await expect(registry.dispatch(command)).resolves.toMatchObject({
      status: 'applied',
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(syncs.settle).not.toHaveBeenCalled();
  });
});
