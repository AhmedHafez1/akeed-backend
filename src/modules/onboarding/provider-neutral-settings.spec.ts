import type { Server } from 'node:http';
import { Test } from '@nestjs/testing';
import { type ExecutionContext, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { OnboardingController } from './onboarding.controller';
import { SettingsController } from './settings.controller';
import { OnboardingService } from './onboarding.service';
import { OnboardingStateService } from './onboarding-state.service';
import { BillingService } from './billing.service';
import { BillingEntitlementService } from '../verification-core/billing-entitlement.service';
import {
  DualAuthGuard,
  type AuthenticatedUser,
} from '../auth/guards/dual-auth.guard';
import type { integrations } from '../../infrastructure/database/schema';

describe('manual entitlement HTTP boundary', () => {
  let app: INestApplication<Server>;
  let source: typeof integrations.$inferSelect;
  let activeSources: (typeof source)[];
  let user: AuthenticatedUser;
  const provider = {
    getShopName: jest.fn(),
    createRecurringApplicationCharge: jest.fn(),
    getAppSubscriptionStatus: jest.fn(),
    cancelAppSubscription: jest.fn(),
  };
  const claims = { hasClaim: jest.fn(), createIfNew: jest.fn() };
  const billingConfig = {
    resolveAllPlans: jest.fn(),
    resolvePlan: jest.fn(),
    isBillingRequired: jest.fn().mockReturnValue(false),
  };
  const repository = {
    findActiveByOrg: jest.fn(),
    findByOrgAndPlatformDomain: jest.fn(),
    updateById: jest.fn(),
  };
  const usage = {
    getEntitlementSource: jest.fn(),
    getIntegrationUsageForPeriod: jest.fn(),
    resetCountersForPeriod: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    source = {
      id: 'int-1',
      orgId: 'org-1',
      platformType: 'standalone',
      platformStoreUrl: 'manual:org-1',
      isActive: true,
      storeName: null,
      defaultLanguage: 'auto',
      isAutoVerifyEnabled: true,
      onboardingStatus: 'completed',
      billingPlanId: 'starter',
      billingStatus: 'not_required',
      billingActivatedAt: '2026-05-01T00:00:00Z',
      shopifySubscriptionId: null,
    } as typeof source;
    activeSources = [source];
    user = { userId: 'user-1', orgId: 'org-1', source: 'supabase' };
    repository.findActiveByOrg.mockImplementation(() =>
      Promise.resolve(activeSources),
    );
    repository.findByOrgAndPlatformDomain.mockImplementation(() =>
      Promise.resolve(source),
    );
    repository.updateById.mockImplementation(
      (_id: string, changes: Partial<typeof source>) =>
        Promise.resolve({ ...source, ...changes }),
    );
    usage.getEntitlementSource.mockImplementation(() =>
      Promise.resolve(source),
    );
    usage.getIntegrationUsageForPeriod.mockResolvedValue({
      consumedCount: 12,
      includedLimit: 30,
    });
    const state = new OnboardingStateService(repository as never, provider);
    const billing = new BillingService(
      repository as never,
      claims as never,
      usage as never,
      provider as never,
      billingConfig as never,
    );
    const service = new OnboardingService(
      state,
      billing,
      new BillingEntitlementService(usage as never),
    );
    const module = await Test.createTestingModule({
      controllers: [OnboardingController, SettingsController],
      providers: [{ provide: OnboardingService, useValue: service }],
    })
      .overrideGuard(DualAuthGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          context
            .switchToHttp()
            .getRequest<{ user: AuthenticatedUser }>().user = user;
          return true;
        },
      })
      .compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
  });

  it('reads manual status and integration usage without Shopify configuration, calls, or claims', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/settings')
      .expect(200);
    expect(response.body).toMatchObject({
      state: {
        billingStatus: 'not_required',
        billingManagement: { mode: 'manual', canManageBilling: false },
      },
      billing: { plans: [], usage: { used: 12, limit: 30 } },
    });
    await request(app.getHttpServer())
      .get('/api/onboarding/billing/plans')
      .expect(200, {
        plans: [],
        isFreePlanClaimed: false,
        billingManagement: { mode: 'manual', canManageBilling: false },
      });
    for (const call of [
      ...Object.values(provider),
      ...Object.values(claims),
      ...Object.values(billingConfig),
    ])
      expect(call).not.toHaveBeenCalled();
    expect(repository.updateById).not.toHaveBeenCalled();
    expect(usage.getIntegrationUsageForPeriod).toHaveBeenCalledWith(
      expect.objectContaining({ integrationId: 'int-1' }),
    );
  });

  it.each(['starter', 'pro'])(
    'rejects public activation of %s even when Shopify billing is disabled',
    async (planId) => {
      await request(app.getHttpServer())
        .post('/api/onboarding/billing')
        .send({ planId, billingStatus: 'not_required' })
        .expect(403);
      expect(repository.updateById).not.toHaveBeenCalled();
      expect(claims.createIfNew).not.toHaveBeenCalled();
      expect(billingConfig.resolvePlan).not.toHaveBeenCalled();
      for (const call of Object.values(provider))
        expect(call).not.toHaveBeenCalled();
    },
  );

  it.each(['/api/settings', '/api/onboarding/settings'])(
    'strips entitlement fields from merchant updates to %s',
    async (route) => {
      await request(app.getHttpServer())
        .patch(route)
        .send({
          storeName: 'Pilot',
          defaultLanguage: 'auto',
          isAutoVerifyEnabled: true,
          billingStatus: 'not_required',
          billingPlanId: 'business',
          billingActivatedAt: '2026-01-01',
          isActive: true,
        })
        .expect(200);
      expect(repository.updateById).toHaveBeenCalledWith('int-1', {
        storeName: 'Pilot',
        defaultLanguage: 'auto',
        isAutoVerifyEnabled: true,
      });
    },
  );

  it('rejects absent and ambiguous active sources', async () => {
    activeSources = [];
    await request(app.getHttpServer()).get('/api/settings').expect(404);
    activeSources = [source, { ...source, id: 'int-2' }];
    await request(app.getHttpServer()).get('/api/settings').expect(409);
  });

  it('keeps Shopify sessions pinned to their exact organization and shop', async () => {
    user = { ...user, source: 'shopify', shop: 'synthetic.myshopify.com' };
    await request(app.getHttpServer()).get('/api/onboarding/state').expect(200);
    expect(repository.findByOrgAndPlatformDomain).toHaveBeenCalledWith(
      'org-1',
      'synthetic.myshopify.com',
      'shopify',
    );
    expect(repository.findActiveByOrg).not.toHaveBeenCalled();
  });
});
