import type { ConfigService } from '@nestjs/config';
import {
  adminStoreLifecycles,
  integrations,
  shopifyOfflineCredentials,
} from '../schema';
import { IntegrationsRepository } from './integrations.repository';

/* eslint-disable @typescript-eslint/no-unsafe-argument */

describe('IntegrationsRepository installation lifecycle', () => {
  function setupUninstall(current: Record<string, unknown> | undefined) {
    const integrationSet = jest.fn<void, [Record<string, unknown>]>();
    const lifecycleSet = jest.fn<void, [Record<string, unknown>]>();
    const returning = jest.fn(() =>
      Promise.resolve([
        {
          id: 'int-1',
          paidThroughAt:
            (integrationSet.mock.calls[0]?.[0]?.paidThroughAt as
              | string
              | undefined) ??
            (current?.paidThroughAt as string | null | undefined) ??
            null,
        },
      ]),
    );
    const forUpdate = jest.fn().mockResolvedValue(current ? [current] : []);
    const tx = {
      select: jest.fn(() => ({
        from: () => ({ where: () => ({ for: forUpdate }) }),
      })),
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
      delete: jest.fn(() => ({ where: () => Promise.resolve(undefined) })),
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
    return { repository, db, tx, forUpdate, integrationSet, lifecycleSet };
  }

  // The real case: Pro activated Oct 31 08:30, uninstalled Nov 11 16:54.
  const paidPro = {
    billingPlanId: 'pro',
    billingStatus: 'active',
    billingActivatedAt: '2026-10-31T08:30:00.000Z',
    billingCanceledAt: null,
    shopifySubscriptionId: 'gid://shopify/AppSubscription/1',
    paidThroughAt: null,
    uninstalledAt: null,
  };
  const uninstallTime = '2026-11-11T16:54:00.000Z';

  it('commits uninstall state and lifecycle closure in one transaction', async () => {
    const { repository, db, tx, forUpdate, integrationSet, lifecycleSet } =
      setupUninstall({ ...paidPro, billingPlanId: 'starter' });

    const result = await repository.markShopifyUninstalled(
      'int-1',
      '2026-08-27T12:00:00.000Z',
    );

    expect(result).toEqual({ id: 'int-1', paidThroughAt: null });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(forUpdate).toHaveBeenCalledWith('update');
    // The refresh token goes with the access token.
    expect(tx.delete).toHaveBeenCalledWith(shopifyOfflineCredentials);
    expect(integrationSet).toHaveBeenCalledWith(
      expect.objectContaining({
        isActive: false,
        accessToken: null,
        webhookSecret: null,
        expiresAt: null,
        billingStatus: 'cancelled',
        pendingBillingPlanId: null,
        shopifySubscriptionId: null,
        onboardingStatus: 'pending',
        billingStatusUpdatedAt: '2026-08-27T12:00:00.000Z',
      }),
    );
    expect(integrationSet.mock.calls[0][0]).not.toHaveProperty('billingPlanId');
    expect(integrationSet.mock.calls[0][0]).not.toHaveProperty('paidThroughAt');
    expect(lifecycleSet).toHaveBeenCalledWith(
      expect.objectContaining({
        uninstalledAt: '2026-08-27T12:00:00.000Z',
      }),
    );
  });

  describe('paid-through date', () => {
    it('records the period end when the cancel webhook comes after the uninstall', async () => {
      const { repository, integrationSet } = setupUninstall(paidPro);

      const result = await repository.markShopifyUninstalled(
        'int-1',
        uninstallTime,
      );

      expect(integrationSet.mock.calls[0][0]).toMatchObject({
        paidThroughAt: '2026-11-30T08:30:00.000Z',
      });
      expect(result?.paidThroughAt).toBe('2026-11-30T08:30:00.000Z');
    });

    it('records it when the cancel webhook landed 80 ms before the uninstall', async () => {
      const { repository, integrationSet } = setupUninstall({
        ...paidPro,
        billingStatus: 'cancelled',
        billingCanceledAt: '2026-11-11T16:53:59.920Z',
      });

      await repository.markShopifyUninstalled('int-1', uninstallTime);

      expect(integrationSet.mock.calls[0][0]).toMatchObject({
        paidThroughAt: '2026-11-30T08:30:00.000Z',
      });
    });

    it.each([
      [
        'the merchant cancelled days before',
        {
          billingStatus: 'cancelled',
          billingCanceledAt: '2026-11-08T10:00:00.000Z',
        },
      ],
      [
        'the subscription froze earlier',
        {
          billingStatus: 'frozen',
          billingCanceledAt: '2026-11-11T16:53:59.920Z',
        },
      ],
      ['the plan is free', { billingPlanId: 'starter' }],
      [
        'billing was bypassed (no Shopify subscription)',
        { billingStatus: 'not_required', shopifySubscriptionId: null },
      ],
      [
        'the uninstall is a redelivery',
        {
          billingStatus: 'cancelled',
          uninstalledAt: '2026-11-11T16:54:00.000Z',
        },
      ],
    ])('records nothing when %s', async (_label, overrides) => {
      const { repository, integrationSet } = setupUninstall({
        ...paidPro,
        ...overrides,
      });

      await repository.markShopifyUninstalled('int-1', uninstallTime);

      expect(integrationSet.mock.calls[0][0]).not.toHaveProperty(
        'paidThroughAt',
      );
    });

    it('never moves a live date: a store in its paid-through period uninstalls again', async () => {
      const { repository, integrationSet } = setupUninstall({
        ...paidPro,
        billingStatus: 'paid_through',
        shopifySubscriptionId: null,
        paidThroughAt: '2026-11-30T08:30:00.000Z',
      });

      const result = await repository.markShopifyUninstalled(
        'int-1',
        '2026-11-20T10:00:00.000Z',
      );

      expect(integrationSet.mock.calls[0][0]).not.toHaveProperty(
        'paidThroughAt',
      );
      expect(result?.paidThroughAt).toBe('2026-11-30T08:30:00.000Z');
    });
  });

  describe('clearPaidThrough', () => {
    function setupClear(current: Record<string, unknown> | undefined) {
      const set = jest.fn<void, [Record<string, unknown>]>();
      const audit = jest.fn();
      const tx = {
        select: jest.fn(() => ({
          from: () => ({
            where: () => ({
              for: jest.fn().mockResolvedValue(current ? [current] : []),
            }),
          }),
        })),
        update: jest.fn(() => ({
          set: (updates: Record<string, unknown>) => {
            set(updates);
            return { where: () => Promise.resolve(undefined) };
          },
        })),
        insert: jest.fn(() => ({
          values: (values: unknown) => {
            audit(values);
            return Promise.resolve(undefined);
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
      return { repository, set, audit };
    }

    it('clears the date and ends a live paid-through plan, audited', async () => {
      const { repository, set, audit } = setupClear({
        orgId: 'org-1',
        billingStatus: 'paid_through',
        paidThroughAt: '2026-11-30T08:30:00.000Z',
      });

      await expect(
        repository.clearPaidThrough('int-1', { userId: 'admin-1' }),
      ).resolves.toBe(true);

      expect(set.mock.calls[0][0]).toMatchObject({
        paidThroughAt: null,
        billingStatus: 'cancelled',
      });
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'admin-1',
          action: 'store.paid-through.clear',
          targetIntegrationId: 'int-1',
        }),
      );
    });

    it('only clears the date of an uninstalled store', async () => {
      const { repository, set } = setupClear({
        orgId: 'org-1',
        billingStatus: 'cancelled',
        paidThroughAt: '2026-11-30T08:30:00.000Z',
      });

      await repository.clearPaidThrough('int-1', { userId: 'admin-1' });

      expect(set.mock.calls[0][0]).toHaveProperty('paidThroughAt', null);
      expect(set.mock.calls[0][0]).not.toHaveProperty('billingStatus');
    });

    it('reports an unknown store', async () => {
      const { repository } = setupClear(undefined);
      await expect(
        repository.clearPaidThrough('int-1', { userId: 'admin-1' }),
      ).resolves.toBe(false);
    });
  });

  function setupUpsert(existing: Record<string, unknown>) {
    const set = jest.fn<void, [Record<string, unknown>]>();
    const db = {
      select: jest.fn(() => ({
        from: () => ({
          where: () => ({ limit: jest.fn().mockResolvedValue([existing]) }),
        }),
      })),
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
    return { repository, set };
  }

  const existingShop = {
    id: 'int-1',
    orgId: 'org-1',
    platformType: 'shopify',
    platformStoreUrl: 'test.myshopify.com',
  };

  it('reactivates installation on reinstall without reviving billing state', async () => {
    const { repository, set } = setupUpsert({
      ...existingShop,
      isActive: false,
      billingStatus: 'cancelled',
      onboardingStatus: 'completed',
    });

    await repository.upsertShopifyIntegration(
      'org-1',
      'test.myshopify.com',
      'shopify',
      'fresh-offline-token',
    );

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ onboardingStatus: 'pending' }),
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

  it('keeps onboarding state when an active install refreshes its token', async () => {
    const { repository, set } = setupUpsert({
      ...existingShop,
      isActive: true,
      onboardingStatus: 'completed',
    });

    await repository.upsertShopifyIntegration(
      'org-1',
      'test.myshopify.com',
      'shopify',
      'fresh-offline-token',
    );

    expect(set.mock.calls[0][0]).not.toHaveProperty('onboardingStatus');
  });
});

/* eslint-enable @typescript-eslint/no-unsafe-argument */
