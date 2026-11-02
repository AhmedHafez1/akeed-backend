import { Logger } from '@nestjs/common';
import { CommerceOutcomeRegistryService } from './commerce-outcome-registry.service';
import { CommerceOutcomeSyncTracker } from './commerce-outcome-sync-tracker.service';
import type {
  CommerceOutcomeAdapter,
  CommerceOutcomeDispatchCommand,
} from '../../shared/commerce/commerce-outcome';

const command: CommerceOutcomeDispatchCommand = {
  orgId: 'org-1',
  integrationId: 'integration-1',
  externalOrderId: 'order-1',
  action: 'customer_confirmation',
  correlationId: 'verification-1',
  retryInBackground: true,
};

function setup(rows: unknown[]) {
  const findForOutcomeDispatch = jest.fn().mockResolvedValue({
    id: 'local-order-1',
    orgId: command.orgId,
    integrationId: command.integrationId,
    externalOrderId: command.externalOrderId,
    integration: {
      id: command.integrationId,
      orgId: command.orgId,
      platformType: 'easyorders',
      isActive: true,
    },
  });
  const syncs = {
    findForOrder: jest.fn().mockResolvedValue(rows),
    begin: jest.fn().mockResolvedValue({ id: 'sync-1', orgId: 'org-1' }),
    settle: jest.fn().mockResolvedValue(undefined),
  };
  const adapter = {
    platformType: 'easyorders',
    requiresActiveConnection: true,
    tracksSynchronization: true,
    capabilities: new Set([command.action]),
    execute: jest.fn().mockResolvedValue({ status: 'applied' }),
  };
  const registry = new CommerceOutcomeRegistryService(
    { findForOutcomeDispatch } as never,
    [adapter as unknown as CommerceOutcomeAdapter],
    new CommerceOutcomeSyncTracker(syncs as never, {} as never),
  );
  return { registry, adapter, syncs };
}

const row = (state: string, nextAttemptAt: string | null = null) => ({
  action: command.action,
  state,
  nextAttemptAt,
});

describe('repeating an outcome', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['succeeded', row('succeeded')],
    [
      'scheduled for a background try',
      row('pending', '2026-11-02T10:00:00.000Z'),
    ],
  ])(
    'leaves the store and the sync row alone when it %s',
    async (_case, sync) => {
      const { registry, adapter, syncs } = setup([sync]);

      await expect(
        registry.dispatch({ ...command, skipIfSynced: true }),
      ).resolves.toMatchObject({ status: 'applied' });

      expect(adapter.execute).not.toHaveBeenCalled();
      expect(syncs.begin).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['has no sync row', []],
    ['stopped mid-try', [row('pending')]],
    ['failed', [row('failed')]],
    [
      'succeeded for another action',
      [{ ...row('succeeded'), action: 'other' }],
    ],
  ])('sends the outcome when it %s', async (_case, rows) => {
    const { registry, adapter } = setup(rows);

    await registry.dispatch({ ...command, skipIfSynced: true });

    expect(adapter.execute).toHaveBeenCalledTimes(1);
  });

  it('sends the outcome when the sync row cannot be read', async () => {
    const { registry, adapter, syncs } = setup([]);
    syncs.findForOrder.mockRejectedValue(new Error('database'));

    await registry.dispatch({ ...command, skipIfSynced: true });

    expect(adapter.execute).toHaveBeenCalledTimes(1);
  });

  it('does not read the sync row on a normal dispatch', async () => {
    const { registry, adapter, syncs } = setup([row('succeeded')]);

    await registry.dispatch(command);

    expect(syncs.findForOrder).not.toHaveBeenCalled();
    expect(adapter.execute).toHaveBeenCalledTimes(1);
  });
});
