import type {
  AutoCancellationRow,
  AutoCancelSnapshot,
} from '../../infrastructure/database/repositories/verification-auto-cancellations.repository';
import type {
  CommerceCancellationInspection,
  CommerceOperationResolution,
  CommerceOutcomeOperationResult,
} from '../../shared/commerce/commerce-outcome';
import { AutoCancellationService } from './auto-cancellation.service';

const DELIVERED = '2026-10-01T08:00:00.000Z';

function baseSnapshot(): AutoCancelSnapshot {
  return {
    verification: {
      id: 'ver-1',
      orgId: 'org-1',
      orderId: 'order-1',
      status: 'no_reply',
      confirmedAt: null,
      canceledAt: null,
      merchantCanceledAt: null,
      customerLastMessageAt: null,
      autoCancelExcludedAt: null,
      followUpAttempts: 1,
      followUpSentAt: '2026-10-01T14:00:00.000Z',
      deliveredAt: DELIVERED,
      readAt: null,
      metadata: {},
    },
    order: {
      id: 'order-1',
      integrationId: 'int-1',
      externalOrderId: '1001',
      isTest: false,
    },
    integration: {
      id: 'int-1',
      platformType: 'shopify',
      autoCancelEnabled: true,
      autoCancelRestock: true,
      autoCancelNotifyCustomer: false,
      quietHoursEnabled: false,
      quietHoursStart: null,
      quietHoursEnd: null,
      timezone: 'Asia/Riyadh',
    },
    initialDeliveredAt: DELIVERED,
    followUpDeliveredAt: '2026-10-01T14:01:00.000Z',
    row: null,
  };
}

/**
 * The repository's contract in memory: every `withLockedVerification` sees
 * the state as it is when the lock is taken, and writes land on that state.
 */
function setup(
  options: {
    snapshot?: Partial<AutoCancelSnapshot>;
    inspect?: (calls: number) => CommerceCancellationInspection;
    dispatch?: () => CommerceOutcomeOperationResult;
    resolve?: () => CommerceOperationResolution;
  } = {},
) {
  const state: { snapshot: AutoCancelSnapshot } = {
    snapshot: { ...baseSnapshot(), ...options.snapshot },
  };
  const events: Array<{ event: string; detail?: Record<string, unknown> }> = [];
  const clone = (): AutoCancelSnapshot => structuredClone(state.snapshot);
  const repo = {
    findById: jest.fn((id: string) =>
      Promise.resolve(
        state.snapshot.row?.id === id ? { ...state.snapshot.row } : undefined,
      ),
    ),
    readSnapshotUnlocked: jest.fn(() => Promise.resolve(clone())),
    withLockedVerification: jest.fn(
      <T>(
        _id: string,
        work: (snapshot: AutoCancelSnapshot, tx: unknown) => Promise<T>,
      ) => work(clone(), {}),
    ),
    insert: jest.fn((_tx: unknown, values: Partial<AutoCancellationRow>) => {
      if (state.snapshot.row) return Promise.resolve(null);
      const row = {
        id: 'row-1',
        attempts: 0,
        reason: null,
        dueAt: null,
        leaseUntil: null,
        providerOperationId: null,
        restock: null,
        notifyCustomer: null,
        dispatchedAt: null,
        completedAt: null,
        lateReplyAt: null,
        createdAt: '2026-10-02T00:00:00.000Z',
        updatedAt: '2026-10-02T00:00:00.000Z',
        ...values,
      } as AutoCancellationRow;
      state.snapshot.row = row;
      return Promise.resolve({ ...row });
    }),
    update: jest.fn(
      (_tx: unknown, _id: string, patch: Partial<AutoCancellationRow>) => {
        if (!state.snapshot.row) return Promise.resolve(null);
        state.snapshot.row = { ...state.snapshot.row, ...patch };
        return Promise.resolve({ ...state.snapshot.row });
      },
    ),
    appendEvent: jest.fn(
      (
        _tx: unknown,
        input: { event: string; detail?: Record<string, unknown> },
      ) => {
        events.push(input);
        return Promise.resolve();
      },
    ),
    markVerificationCanceled: jest.fn(() => {
      if (state.snapshot.verification.status !== 'no_reply')
        return Promise.resolve(false);
      state.snapshot.verification.status = 'canceled';
      return Promise.resolve(true);
    }),
    setExclusion: jest.fn(
      (_tx: unknown, _id: string, excludedBy: string | null) => {
        state.snapshot.verification.autoCancelExcludedAt = excludedBy
          ? new Date().toISOString()
          : null;
        return Promise.resolve();
      },
    ),
    listDue: jest.fn(() => Promise.resolve([])),
    listPaused: jest.fn(() => Promise.resolve([])),
    listExpiredLeases: jest.fn(() => Promise.resolve([])),
    listAwaitingPlatform: jest.fn(() => Promise.resolve([])),
  };
  let inspections = 0;
  const registry = {
    inspectForCancellation: jest.fn(() => {
      inspections += 1;
      return Promise.resolve(
        options.inspect?.(inspections) ?? { state: 'cancellable' as const },
      );
    }),
    dispatch: jest.fn((command: { action: string }) =>
      Promise.resolve<CommerceOutcomeOperationResult>(
        command.action === 'automatic_no_reply_cancellation'
          ? (options.dispatch?.() ?? { status: 'applied' })
          : { status: 'applied' },
      ),
    ),
    resolveOperation: jest.fn(() =>
      Promise.resolve(options.resolve?.() ?? ({ state: 'done' } as const)),
    ),
  };
  const producer = {
    enqueueExecute: jest.fn(() => Promise.resolve()),
    enqueueConfirm: jest.fn(() => Promise.resolve()),
  };
  const service = new AutoCancellationService(
    repo as never,
    registry as never,
    producer as never,
  );
  const cancelCalls = () =>
    registry.dispatch.mock.calls.filter(
      ([command]) => command.action === 'automatic_no_reply_cancellation',
    );
  return { service, state, events, repo, registry, producer, cancelCalls };
}

async function scheduledAndDue(harness: ReturnType<typeof setup>) {
  await harness.service.scheduleAfterNoReply('ver-1');
  expect(harness.state.snapshot.row?.status).toBe('scheduled');
}

describe('AutoCancellationService', () => {
  describe('scheduleAfterNoReply', () => {
    it('schedules a fully delivered, unanswered order and enqueues it', async () => {
      const harness = setup();
      await scheduledAndDue(harness);
      expect(harness.producer.enqueueExecute).toHaveBeenCalledWith(
        'row-1',
        expect.any(Date),
      );
      expect(harness.events.map(({ event }) => event)).toEqual(['scheduled']);
    });

    it('creates nothing for a store that has it off', async () => {
      const harness = setup({
        snapshot: {
          integration: {
            ...baseSnapshot().integration,
            autoCancelEnabled: false,
          },
        },
      });
      await harness.service.scheduleAfterNoReply('ver-1');
      expect(harness.state.snapshot.row).toBeNull();
      expect(harness.producer.enqueueExecute).not.toHaveBeenCalled();
    });

    it('pauses, and never cancels, when the reminder was blocked by credits', async () => {
      const snapshot = baseSnapshot();
      const harness = setup({
        snapshot: {
          verification: {
            ...snapshot.verification,
            followUpAttempts: 0,
            followUpSentAt: null,
            metadata: { follow_up_skipped: 'INSUFFICIENT_CREDITS' },
          },
          followUpDeliveredAt: null,
        },
      });
      await harness.service.scheduleAfterNoReply('ver-1');
      expect(harness.state.snapshot.row).toMatchObject({
        status: 'paused',
        reason: 'reminder_blocked',
      });
      await harness.service.execute('row-1');
      expect(harness.cancelCalls()).toHaveLength(0);
    });

    it('pauses while the reminder delivery is unknown, and resumes once it is delivered', async () => {
      const harness = setup({ snapshot: { followUpDeliveredAt: null } });
      await harness.service.scheduleAfterNoReply('ver-1');
      expect(harness.state.snapshot.row?.status).toBe('paused');

      harness.state.snapshot.followUpDeliveredAt = '2026-10-01T15:00:00.000Z';
      await harness.service.reevaluate('row-1');
      expect(harness.state.snapshot.row?.status).toBe('scheduled');
      expect(harness.events.map(({ event }) => event)).toEqual([
        'paused',
        'resumed',
      ]);
    });

    it('is created once: a repeated escalation does nothing', async () => {
      const harness = setup();
      await harness.service.scheduleAfterNoReply('ver-1');
      await harness.service.scheduleAfterNoReply('ver-1');
      expect(harness.repo.insert).toHaveBeenCalledTimes(1);
      expect(harness.producer.enqueueExecute).toHaveBeenCalledTimes(1);
    });
  });

  describe('execute', () => {
    it('cancels with the merchant restock and notify settings, then records success', async () => {
      const harness = setup();
      await scheduledAndDue(harness);
      await harness.service.execute('row-1');

      expect(harness.cancelCalls()).toHaveLength(1);
      expect(harness.cancelCalls()[0][0]).toMatchObject({
        action: 'automatic_no_reply_cancellation',
        cancellation: { restock: true, notifyCustomer: false },
      });
      expect(harness.state.snapshot.row?.status).toBe('succeeded');
      expect(harness.state.snapshot.verification.status).toBe('canceled');
      expect(harness.events.map(({ event }) => event)).toEqual([
        'scheduled',
        'dispatch_started',
        'succeeded',
      ]);
      expect(harness.events.at(-1)?.detail).toMatchObject({
        reason: 'No response after confirmation attempts',
      });
    });

    it('does nothing for a duplicate job that arrives while the first runs', async () => {
      const harness = setup({
        inspect: () => ({ state: 'cancellable' }),
      });
      await scheduledAndDue(harness);
      harness.registry.inspectForCancellation.mockImplementationOnce(
        async () => {
          await harness.service.execute('row-1');
          return { state: 'cancellable' };
        },
      );
      await harness.service.execute('row-1');
      await harness.service.execute('row-1');

      expect(harness.cancelCalls()).toHaveLength(1);
      expect(harness.state.snapshot.row?.status).toBe('succeeded');
    });

    it('stops without calling the store when the customer replies between the claim and the dispatch', async () => {
      const harness = setup({
        inspect: () => {
          harness.state.snapshot.verification.customerLastMessageAt =
            new Date().toISOString();
          return { state: 'cancellable' };
        },
      });
      await scheduledAndDue(harness);
      await harness.service.execute('row-1');

      expect(harness.cancelCalls()).toHaveLength(0);
      expect(harness.state.snapshot.row).toMatchObject({
        status: 'stopped',
        reason: 'customer_reply',
      });
      expect(harness.state.snapshot.verification.status).toBe('no_reply');
    });

    it('stops when the merchant switched it off before the job ran', async () => {
      const harness = setup();
      await scheduledAndDue(harness);
      harness.state.snapshot.integration.autoCancelEnabled = false;
      await harness.service.execute('row-1');

      expect(harness.registry.inspectForCancellation).not.toHaveBeenCalled();
      expect(harness.state.snapshot.row).toMatchObject({
        status: 'stopped',
        reason: 'feature_disabled',
      });
    });

    it('honors an exclusion made after scheduling', async () => {
      const harness = setup();
      await scheduledAndDue(harness);
      harness.state.snapshot.verification.autoCancelExcludedAt =
        new Date().toISOString();
      await harness.service.execute('row-1');

      expect(harness.cancelCalls()).toHaveLength(0);
      expect(harness.state.snapshot.row?.reason).toBe('excluded');
    });

    it.each([
      ['paid', 'paid'],
      ['fulfilled', 'fulfilled'],
      ['handed to fulfillment', 'fulfillment_in_progress'],
    ] as const)(
      'skips an order the store reports %s',
      async (_label, reason) => {
        const harness = setup({
          inspect: () => ({ state: 'not_cancellable', reason }),
        });
        await scheduledAndDue(harness);
        await harness.service.execute('row-1');

        expect(harness.cancelCalls()).toHaveLength(0);
        expect(harness.state.snapshot.row).toMatchObject({
          status: 'skipped',
          reason,
        });
        expect(harness.state.snapshot.verification.status).toBe('no_reply');
      },
    );

    it('records an order already canceled in the store without a second cancel or notice', async () => {
      const harness = setup({
        inspect: () => ({ state: 'already_canceled' }),
      });
      await scheduledAndDue(harness);
      await harness.service.execute('row-1');

      expect(harness.cancelCalls()).toHaveLength(0);
      expect(harness.state.snapshot.row?.status).toBe('succeeded');
    });

    it('retries a retryable store failure with back-off, then fails for the merchant', async () => {
      const harness = setup({
        dispatch: () => ({
          status: 'retryable_failure',
          errorCode: 'source_unavailable',
        }),
      });
      await scheduledAndDue(harness);
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        harness.state.snapshot.row = {
          ...harness.state.snapshot.row!,
          dueAt: new Date(0).toISOString(),
        };
        await harness.service.execute('row-1');
      }

      expect(harness.cancelCalls()).toHaveLength(5);
      expect(harness.state.snapshot.row).toMatchObject({
        status: 'failed',
        reason: 'source_unavailable',
        attempts: 5,
      });
      expect(harness.state.snapshot.verification.status).toBe('no_reply');
      expect(
        harness.events.filter(({ event }) => event === 'retry_scheduled'),
      ).toHaveLength(4);
    });

    it('fails a permanent store refusal without marking the order canceled', async () => {
      const harness = setup({
        dispatch: () => ({
          status: 'permanent_failure',
          errorCode: 'remote_state_conflict',
        }),
      });
      await scheduledAndDue(harness);
      await harness.service.execute('row-1');

      expect(harness.state.snapshot.row).toMatchObject({
        status: 'failed',
        reason: 'remote_state_conflict',
      });
      expect(harness.state.snapshot.verification.status).toBe('no_reply');
    });
  });

  describe('asynchronous store confirmation', () => {
    it('records success only once the store job finished and the order reads canceled', async () => {
      const harness = setup({
        inspect: (calls) =>
          calls === 1
            ? { state: 'cancellable' }
            : { state: 'already_canceled' },
        dispatch: () => ({
          status: 'pending_provider_operation',
          providerOperationId: 'gid://shopify/Job/1',
        }),
        resolve: () => ({ state: 'running' }),
      });
      await scheduledAndDue(harness);
      await harness.service.execute('row-1');
      expect(harness.state.snapshot.row?.status).toBe('awaiting_platform');
      expect(harness.state.snapshot.verification.status).toBe('no_reply');

      await harness.service.confirm('row-1');
      expect(harness.state.snapshot.row?.status).toBe('awaiting_platform');
      expect(harness.producer.enqueueConfirm).toHaveBeenCalledTimes(2);

      harness.registry.resolveOperation.mockResolvedValue({ state: 'done' });
      await harness.service.confirm('row-1');
      expect(harness.state.snapshot.row?.status).toBe('succeeded');
      expect(harness.state.snapshot.verification.status).toBe('canceled');
    });

    it('completes the cancel the store accepted even if the customer replies meanwhile', async () => {
      const harness = setup({
        inspect: (calls) =>
          calls === 1
            ? { state: 'cancellable' }
            : { state: 'already_canceled' },
        dispatch: () => {
          harness.state.snapshot.verification.customerLastMessageAt =
            new Date().toISOString();
          return {
            status: 'pending_provider_operation',
            providerOperationId: 'job-1',
          };
        },
      });
      await scheduledAndDue(harness);
      await harness.service.execute('row-1');
      await harness.service.confirm('row-1');

      expect(harness.cancelCalls()).toHaveLength(1);
      expect(harness.state.snapshot.row?.status).toBe('succeeded');
    });

    it('fails for the merchant when the store never confirms', async () => {
      const harness = setup({
        dispatch: () => ({
          status: 'pending_provider_operation',
          providerOperationId: 'job-1',
        }),
        resolve: () => ({ state: 'running' }),
      });
      await scheduledAndDue(harness);
      await harness.service.execute('row-1');
      harness.state.snapshot.row = {
        ...harness.state.snapshot.row!,
        dispatchedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      };
      await harness.service.confirm('row-1');

      expect(harness.state.snapshot.row).toMatchObject({
        status: 'failed',
        reason: 'platform_confirmation_timeout',
      });
      expect(harness.state.snapshot.verification.status).toBe('no_reply');
    });
  });

  describe('exclusion', () => {
    const owner = { userId: 'user-1', orgId: 'org-1', role: 'owner' } as never;

    it('stops a scheduled cancellation and audits who excluded it', async () => {
      const harness = setup();
      await scheduledAndDue(harness);
      await expect(harness.service.exclude(owner, 'ver-1')).resolves.toEqual({
        verificationId: 'ver-1',
        excluded: true,
      });
      expect(harness.state.snapshot.row).toMatchObject({
        status: 'stopped',
        reason: 'excluded',
      });
      expect(harness.repo.appendEvent).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ event: 'excluded', actorUserId: 'user-1' }),
      );
    });

    it('lets an included order be scheduled again', async () => {
      const harness = setup();
      await scheduledAndDue(harness);
      await harness.service.exclude(owner, 'ver-1');
      await harness.service.include(owner, 'ver-1');
      expect(harness.state.snapshot.row?.status).toBe('scheduled');
    });

    it('refuses once the store is already canceling the order', async () => {
      const harness = setup({
        dispatch: () => ({
          status: 'pending_provider_operation',
          providerOperationId: 'job-1',
        }),
      });
      await scheduledAndDue(harness);
      await harness.service.execute('row-1');
      await expect(
        harness.service.exclude(owner, 'ver-1'),
      ).rejects.toMatchObject({
        response: { code: 'AUTO_CANCEL_ALREADY_IN_PROGRESS' },
      });
    });

    it('is refused to a viewer', async () => {
      const harness = setup();
      await expect(
        harness.service.exclude(
          { userId: 'u', orgId: 'org-1', role: 'viewer' } as never,
          'ver-1',
        ),
      ).rejects.toMatchObject({
        response: { code: 'VERIFICATION_ROLE_REQUIRED' },
      });
    });

    it('treats another organization as not found', async () => {
      const harness = setup();
      await expect(
        harness.service.exclude(
          { userId: 'u', orgId: 'org-2', role: 'owner' } as never,
          'ver-1',
        ),
      ).rejects.toThrow('Verification not found');
    });
  });
});
