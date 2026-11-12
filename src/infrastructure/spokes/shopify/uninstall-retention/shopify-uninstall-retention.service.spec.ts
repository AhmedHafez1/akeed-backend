import { Logger } from '@nestjs/common';
import { ShopifyUninstallRetentionScheduler } from './shopify-uninstall-retention.scheduler';
import { ShopifyUninstallRetentionService } from './shopify-uninstall-retention.service';
import {
  SHOPIFY_UNINSTALL_DATA_RETENTION_MS,
  SHOPIFY_UNINSTALL_RETENTION_EVERY_MS,
  SHOPIFY_UNINSTALL_RETENTION_JOB,
  SHOPIFY_UNINSTALL_RETENTION_SCHEDULER,
} from './shopify-uninstall-retention.constants';

const NOW = new Date('2026-11-12T12:00:00.000Z');
const counts = {
  orders: 3,
  verifications: 3,
  webhookEvents: 4,
  messageDispatches: 1,
  integrations: 1,
  organizations: 1,
};

function setup(outcomes: Array<unknown>) {
  const stores = outcomes.map((_, index) => ({
    id: `int-${index}`,
    orgId: `org-${index}`,
    platformStoreUrl: `Store-${index}.myshopify.com`,
  }));
  const integrationsRepo = {
    findUninstalledShopifyDueForDeletion: jest.fn().mockResolvedValue(stores),
  };
  const deletion = { deleteUninstalledShopifyStore: jest.fn() };
  for (const outcome of outcomes)
    if (outcome instanceof Error)
      deletion.deleteUninstalledShopifyStore.mockRejectedValueOnce(outcome);
    else deletion.deleteUninstalledShopifyStore.mockResolvedValueOnce(outcome);
  const service = new ShopifyUninstallRetentionService(
    integrationsRepo as never,
    deletion as never,
  );
  return { service, integrationsRepo, deletion };
}

describe('ShopifyUninstallRetentionService', () => {
  let lines: string[];
  beforeEach(() => {
    lines = [];
    for (const level of ['log', 'warn', 'error'] as const)
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => {
          lines.push(String(args[0]));
        });
  });
  afterEach(() => jest.restoreAllMocks());

  it('is the 48-hour Shopify window, not a setting', () => {
    expect(SHOPIFY_UNINSTALL_DATA_RETENTION_MS).toBe(48 * 60 * 60 * 1000);
  });

  it('selects stores uninstalled 48 hours ago or more and deletes each through the guarded routine', async () => {
    const { service, integrationsRepo, deletion } = setup([
      { outcome: 'deleted', counts },
    ]);

    const result = await service.run(NOW);

    const cutoff = new Date(
      NOW.getTime() - SHOPIFY_UNINSTALL_DATA_RETENTION_MS,
    ).toISOString();
    expect(
      integrationsRepo.findUninstalledShopifyDueForDeletion,
    ).toHaveBeenCalledWith(cutoff, 100);
    expect(deletion.deleteUninstalledShopifyStore).toHaveBeenCalledWith(
      {
        orgId: 'org-0',
        integrationId: 'int-0',
        platform: 'shopify',
        storeDomain: 'store-0.myshopify.com',
      },
      { dueBefore: cutoff },
    );
    expect(result).toMatchObject({ due: 1, deletedStores: 1, failed: 0 });
  });

  it('skips a reinstalled or already deleted store and keeps going after a failure', async () => {
    const { service, deletion } = setup([
      { outcome: 'skipped', reason: 'reinstalled' },
      new Error('credit records'),
      { outcome: 'skipped', reason: 'not_found' },
      { outcome: 'deleted', counts },
    ]);

    const result = await service.run(NOW);

    expect(deletion.deleteUninstalledShopifyStore).toHaveBeenCalledTimes(4);
    expect(result).toEqual({
      due: 4,
      deletedStores: 1,
      skippedReinstalled: 1,
      skippedNotFound: 1,
      skippedNotDue: 0,
      failed: 1,
    });
    expect(lines.some((line) => line.includes('"reason":"reinstalled"'))).toBe(
      true,
    );
  });

  it('logs counts and ids only', async () => {
    const { service } = setup([{ outcome: 'deleted', counts }]);
    await service.run(NOW);
    for (const line of lines)
      expect(line).not.toMatch(/phone|email|customer|raw_payload/i);
  });
});

describe('ShopifyUninstallRetentionScheduler', () => {
  const queue = { upsertJobScheduler: jest.fn() };
  beforeEach(() => {
    jest.resetAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('keeps one schedule every 15 minutes, never retried', async () => {
    await new ShopifyUninstallRetentionScheduler(queue as never).ensure();

    expect(SHOPIFY_UNINSTALL_RETENTION_EVERY_MS).toBe(15 * 60 * 1000);
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      SHOPIFY_UNINSTALL_RETENTION_SCHEDULER,
      { every: SHOPIFY_UNINSTALL_RETENTION_EVERY_MS },
      expect.objectContaining({
        name: SHOPIFY_UNINSTALL_RETENTION_JOB,
        opts: expect.objectContaining({ attempts: 1 }) as unknown,
      }),
    );
  });

  it('never throws when the queue is unavailable', async () => {
    queue.upsertJobScheduler.mockRejectedValue(new Error('redis down'));
    await expect(
      new ShopifyUninstallRetentionScheduler(queue as never).ensure(),
    ).resolves.toBeUndefined();
  });
});
