import { ConfigService } from '@nestjs/config';
import { WebhookDispatchReconciler } from './webhook-dispatch-reconciler.service';

describe('WebhookDispatchReconciler', () => {
  it('recovers a bounded candidate set and reports claim collisions', async () => {
    const events = {
      findRecoverable: jest
        .fn()
        .mockResolvedValue([{ id: 'event-1' }, { id: 'event-2' }]),
      findOrdersMissingVerification: jest.fn().mockResolvedValue([]),
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
      orphanCandidates: 0,
      orphanDispatched: 0,
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
      findOrdersMissingVerification: jest.fn().mockResolvedValue([]),
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
      orphanCandidates: 0,
      orphanDispatched: 0,
      dryRun: true,
    });
    expect(dispatcher.dispatchById).not.toHaveBeenCalled();
  });

  it('recovers an accepted order that has no verification even when its event looks healthy', async () => {
    // The event-level sweep finds nothing: this is the order-level backstop,
    // the pass that answers "was this order actually verified?".
    const events = {
      findRecoverable: jest.fn().mockResolvedValue([]),
      findOrdersMissingVerification: jest
        .fn()
        .mockResolvedValue([{ eventId: 'event-9', orderId: 'order-9' }]),
    };
    const dispatcher = {
      staleBefore: '2026-09-03T00:00:00.000Z',
      retryLimit: 8,
      dispatchById: jest.fn().mockResolvedValue('dispatched'),
    };
    const reconciler = new WebhookDispatchReconciler(
      events as never,
      dispatcher as never,
      new ConfigService({ WEBHOOK_ORPHAN_ORDER_GRACE_MS: 120000 }),
    );

    await expect(reconciler.reconcileOnce()).resolves.toEqual({
      candidates: 0,
      dispatched: 0,
      notClaimed: 0,
      failed: 0,
      orphanCandidates: 1,
      orphanDispatched: 1,
      dryRun: false,
    });
    expect(dispatcher.dispatchById).toHaveBeenCalledWith('event-9');
  });

  it('does not dispatch the same event twice when both passes select it', async () => {
    const events = {
      findRecoverable: jest.fn().mockResolvedValue([{ id: 'event-9' }]),
      findOrdersMissingVerification: jest
        .fn()
        .mockResolvedValue([{ eventId: 'event-9', orderId: 'order-9' }]),
    };
    const dispatcher = {
      staleBefore: '2026-09-03T00:00:00.000Z',
      retryLimit: 8,
      dispatchById: jest.fn().mockResolvedValue('dispatched'),
    };
    const reconciler = new WebhookDispatchReconciler(
      events as never,
      dispatcher as never,
      new ConfigService({}),
    );

    const result = await reconciler.reconcileOnce();
    expect(result.dispatched).toBe(1);
    expect(result.orphanDispatched).toBe(0);
    expect(dispatcher.dispatchById).toHaveBeenCalledTimes(1);
  });
});
