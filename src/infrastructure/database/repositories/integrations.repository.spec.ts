import type { ConfigService } from '@nestjs/config';
import { adminStoreLifecycles, integrations } from '../schema';
import { IntegrationsRepository } from './integrations.repository';

/* eslint-disable @typescript-eslint/no-unsafe-argument */

describe('IntegrationsRepository installation lifecycle', () => {
  it('commits uninstall state and lifecycle closure in one transaction', async () => {
    const integrationSet = jest.fn<void, [Record<string, unknown>]>();
    const lifecycleSet = jest.fn<void, [Record<string, unknown>]>();
    const returning = jest.fn().mockResolvedValue([{ id: 'int-1' }]);
    const tx = {
      update: jest.fn((table: unknown) => ({
        set: (updates: Record<string, unknown>) => {
          if (table === integrations) integrationSet(updates);
          if (table === adminStoreLifecycles) lifecycleSet(updates);
          return {
            where: () =>
              table === integrations
                ? { returning }
                : Promise.resolve(undefined),
          };
        },
      })),
    };
    const db = {
      transaction: jest.fn((callback: (transaction: typeof tx) => unknown) =>
        Promise.resolve(callback(tx)),
      ),
    };
    const repository = new IntegrationsRepository(
      db as any,
      {} as ConfigService,
    );

    const result = await repository.markShopifyUninstalled(
      'int-1',
      '2026-08-27T12:00:00.000Z',
    );

    expect(result).toEqual({ id: 'int-1' });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(integrationSet).toHaveBeenCalledWith(
      expect.objectContaining({
        isActive: false,
        accessToken: null,
        webhookSecret: null,
        expiresAt: null,
        billingStatus: 'cancelled',
        pendingBillingPlanId: null,
        billingStatusUpdatedAt: '2026-08-27T12:00:00.000Z',
      }),
    );
    expect(lifecycleSet).toHaveBeenCalledWith(
      expect.objectContaining({
        uninstalledAt: '2026-08-27T12:00:00.000Z',
      }),
    );
  });

  it('reactivates installation on reinstall without reviving billing state', async () => {
    const set = jest.fn<void, [Record<string, unknown>]>();
    const existing = {
      id: 'int-1',
      orgId: 'org-1',
      platformType: 'shopify',
      platformStoreUrl: 'test.myshopify.com',
      isActive: false,
      billingStatus: 'cancelled',
    };
    const db = {
      query: {
        integrations: {
          findFirst: jest.fn().mockResolvedValue(existing),
        },
      },
      update: jest.fn(() => ({
        set: (updates: Record<string, unknown>) => {
          set(updates);
          return {
            where: () => ({
              returning: jest
                .fn()
                .mockResolvedValue([{ ...existing, ...updates }]),
            }),
          };
        },
      })),
    };
    const config = {
      getOrThrow: jest.fn().mockReturnValue('a'.repeat(32)),
    };
    const repository = new IntegrationsRepository(
      db as any,
      config as unknown as ConfigService,
    );

    await repository.upsertShopifyIntegration(
      'org-1',
      'test.myshopify.com',
      'shopify',
      'fresh-offline-token',
    );

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        isActive: true,
        orgId: 'org-1',
        platformStoreUrl: 'test.myshopify.com',
      }),
    );
    const updates = set.mock.calls[0][0];
    expect(updates.accessToken).not.toBe('fresh-offline-token');
    expect(updates).not.toHaveProperty('billingStatus');
    expect(updates).not.toHaveProperty('billingPlanId');
  });
});

/* eslint-enable @typescript-eslint/no-unsafe-argument */
