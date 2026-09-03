import { ConfigService } from '@nestjs/config';
import { WebhookDispatchReconciler } from './webhook-dispatch-reconciler.service';

describe('WebhookDispatchReconciler', () => {
  it('recovers a bounded candidate set and reports claim collisions', async () => {
    const events = {
      findRecoverable: jest
        .fn()
        .mockResolvedValue([{ id: 'event-1' }, { id: 'event-2' }]),
    };
    const dispatcher = {
      staleBefore: '2026-09-03T00:00:00.000Z',
      retryLimit: 8,
      dispatchById: jest
        .fn()
        .mockResolvedValueOnce('dispatched')
        .mockResolvedValueOnce('not_claimed'),
    };
    const reconciler = new WebhookDispatchReconciler(
      events as never,
      dispatcher as never,
      new ConfigService({
        WEBHOOK_RECONCILIATION_ENABLED: false,
        WEBHOOK_RECONCILIATION_BATCH_SIZE: 2,
      }),
    );

    await expect(reconciler.reconcileOnce()).resolves.toEqual({
      candidates: 2,
      dispatched: 1,
      notClaimed: 1,
      failed: 0,
      dryRun: false,
    });
    expect(events.findRecoverable).toHaveBeenCalledWith(
      2,
      dispatcher.staleBefore,
      8,
    );
  });

  it('supports a read-only dry run before rollout', async () => {
    const events = {
      findRecoverable: jest.fn().mockResolvedValue([{ id: 'event-1' }]),
    };
    const dispatcher = {
      staleBefore: '2026-09-03T00:00:00.000Z',
      retryLimit: 8,
      dispatchById: jest.fn(),
    };
    const reconciler = new WebhookDispatchReconciler(
      events as never,
      dispatcher as never,
      new ConfigService({ WEBHOOK_RECONCILIATION_DRY_RUN: true }),
    );

    await expect(reconciler.reconcileOnce()).resolves.toEqual({
      candidates: 1,
      dispatched: 0,
      notClaimed: 0,
      failed: 0,
      dryRun: true,
    });
    expect(dispatcher.dispatchById).not.toHaveBeenCalled();
  });
});
