import { usageAccountingFixture } from '../../../test/contracts/usage-accounting-fixture';
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
import type { OnboardingStateDto } from './dto/onboarding.dto';

describe('manual entitlement HTTP boundary', () => {
  let app: INestApplication<Server>;
  let source: typeof integrations.$inferSelect;
  let activeSources: (typeof source)[];
  let user: AuthenticatedUser;
  let completionWriteCount: number;
  let approvalStatus: 'pending_approval' | 'active' | 'suspended' | null;
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
    findByOrg: jest.fn(),
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
    approvalStatus = null;
    source = {
      id: 'int-1',
      orgId: 'org-1',
      platformType: 'standalone',
      platformStoreUrl: 'manual:org-1',
      isActive: true,
      storeName: null,
      defaultLanguage: 'auto',
      isAutoVerifyEnabled: true,
      assumeCodWhenPaymentMissing: false,
      onboardingStatus: 'completed',
      billingPlanId: 'starter',
      billingStatus: 'not_required',
      billingActivatedAt: '2026-05-01T00:00:00Z',
      shopifySubscriptionId: null,
      followUpEnabled: true,
      followUpDelayMinutes: 120,
      escalationEnabled: true,
      escalationDelayMinutes: 360,
      quietHoursEnabled: false,
      quietHoursStart: null,
      quietHoursEnd: null,
      timezone: 'Africa/Cairo',
      sendDelayMinutes: 0,
    } as typeof source;
    activeSources = [source];
    completionWriteCount = 0;
    user = {
      userId: 'user-1',
      orgId: 'org-1',
      role: 'owner',
      source: 'supabase',
    };
    repository.findActiveByOrg.mockImplementation(() =>
      Promise.resolve(activeSources),
    );
    repository.findByOrgAndPlatformDomain.mockImplementation(() =>
      Promise.resolve(source),
    );
    repository.findByOrg.mockImplementation(() => Promise.resolve([]));
    repository.updateById.mockImplementation(
      (_id: string, changes: Partial<typeof source>) => {
        if (changes.onboardingStatus === 'completed') {
          completionWriteCount += 1;
        }
        source = { ...source, ...changes };
        activeSources = activeSources.map((entry) =>
          entry.id === source.id ? source : entry,
        );
        return Promise.resolve(source);
      },
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
      new BillingEntitlementService(usage as never, usageAccountingFixture()),
      { readStatus: () => Promise.resolve(approvalStatus) } as never,
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
      billing: { plans: [], usage: { used: 0, limit: 30 } },
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
    expect(usage.getIntegrationUsageForPeriod).not.toHaveBeenCalled();
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
          orgId: 'forged-org',
          integrationId: 'forged-source',
          role: 'owner',
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
    await request(app.getHttpServer())
      .get('/api/settings')
      .expect(404)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'ONBOARDING_SOURCE_MISSING' });
      });
    activeSources = [source, { ...source, id: 'int-2' }];
    await request(app.getHttpServer())
      .get('/api/settings')
      .expect(409)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'ONBOARDING_SOURCE_AMBIGUOUS' });
      });
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

  it('lets viewers read while rejecting configuration and completion writes', async () => {
    user = { ...user, role: 'viewer' };

    await request(app.getHttpServer())
      .get('/api/settings')
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          state: {
            permissions: {
              canUpdateConfiguration: false,
              canCompleteOnboarding: false,
            },
          },
        });
      });
    await request(app.getHttpServer())
      .patch('/api/settings')
      .send({
        storeName: 'Viewer edit',
        defaultLanguage: 'auto',
        isAutoVerifyEnabled: false,
      })
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/onboarding/complete')
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/onboarding/billing')
      .send({ planId: 'pro' })
      .expect(403);
    expect(repository.updateById).not.toHaveBeenCalled();
  });

  it('allows an admin membership to update Standalone configuration', async () => {
    user = { ...user, role: 'admin' };

    await request(app.getHttpServer())
      .patch('/api/onboarding/settings')
      .send({
        storeName: 'Admin merchant',
        defaultLanguage: 'ar',
        isAutoVerifyEnabled: false,
        assumeCodWhenPaymentMissing: true,
      })
      .expect(200);

    expect(source).toMatchObject({
      storeName: 'Admin merchant',
      defaultLanguage: 'ar',
      isAutoVerifyEnabled: false,
      assumeCodWhenPaymentMissing: true,
    });
  });

  it('completes approved credit setup without requiring legacy plan fields', async () => {
    source = {
      ...source,
      onboardingStatus: 'pending',
      billingPlanId: null,
      billingStatus: null,
      billingActivatedAt: null,
    };
    activeSources = [source];

    await request(app.getHttpServer())
      .patch('/api/onboarding/settings')
      .send({
        storeName: 'Saved before activation',
        defaultLanguage: 'en',
        isAutoVerifyEnabled: false,
        assumeCodWhenPaymentMissing: false,
      })
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/onboarding/complete')
      .expect(201);
    expect(source.storeName).toBe('Saved before activation');
  });

  it('blocks completion with STANDALONE_APPROVAL_REQUIRED while approval is pending', async () => {
    approvalStatus = 'pending_approval';
    source = {
      ...source,
      onboardingStatus: 'pending',
      storeName: 'Waiting merchant',
      billingPlanId: null,
      billingStatus: null,
      billingActivatedAt: null,
    };
    activeSources = [source];

    await request(app.getHttpServer())
      .get('/api/onboarding/state')
      .expect(200)
      .expect(({ body }: { body: { state: OnboardingStateDto } }) => {
        expect(body.state.standaloneSetup).toMatchObject({
          canComplete: false,
          blockedReasons: ['approval_required'],
          approvalStatus: 'pending_approval',
        });
      });
    await request(app.getHttpServer())
      .post('/api/onboarding/complete')
      .expect(409)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          code: 'STANDALONE_APPROVAL_REQUIRED',
          approvalStatus: 'pending_approval',
        });
      });
    expect(completionWriteCount).toBe(0);
  });

  it('completes valid Standalone setup idempotently', async () => {
    source = { ...source, onboardingStatus: 'pending', storeName: 'Pilot' };
    activeSources = [source];

    await request(app.getHttpServer())
      .post('/api/onboarding/complete')
      .expect(201)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          state: {
            onboardingStatus: 'completed',
            isOnboardingComplete: true,
          },
        });
      });
    expect(completionWriteCount).toBe(1);

    await request(app.getHttpServer())
      .post('/api/onboarding/complete')
      .expect(201);
    expect(completionWriteCount).toBe(1);
  });

  it('blocks completion when persisted automation settings are invalid', async () => {
    source = {
      ...source,
      onboardingStatus: 'pending',
      storeName: 'Invalid automation pilot',
      sendDelayMinutes: 1441,
    };
    activeSources = [source];

    await request(app.getHttpServer())
      .post('/api/onboarding/complete')
      .expect(409)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          code: 'ONBOARDING_BLOCKED',
          blockedReasons: ['automation_invalid'],
        });
      });
    expect(completionWriteCount).toBe(0);
  });

  it('returns stable source resolution codes', async () => {
    activeSources = [];
    repository.findByOrg.mockResolvedValue([{ ...source, isActive: false }]);
    await request(app.getHttpServer())
      .get('/api/onboarding/state')
      .expect(404)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'ONBOARDING_SOURCE_INACTIVE' });
      });

    repository.findByOrg.mockResolvedValue([]);
    await request(app.getHttpServer())
      .get('/api/onboarding/state')
      .expect(404)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'ONBOARDING_SOURCE_MISSING' });
      });
  });
});
