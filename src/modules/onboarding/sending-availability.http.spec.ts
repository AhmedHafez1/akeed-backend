import { Test } from '@nestjs/testing';
import type { INestApplication, ExecutionContext } from '@nestjs/common';
import request from 'supertest';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';
import { OnboardingStateService } from './onboarding-state.service';
import { SendingAvailabilityService } from './sending-availability.service';
import { BillingEntitlementService } from '../verification-core/billing-entitlement.service';
import { DualAuthGuard } from '../auth/guards/dual-auth.guard';
import { seededTemplateRegistry } from '../../shared/messaging/testing/seeded-template-registry';
import { resolveBillingPlan } from '../../shared/billing/billing-plan';
import type { Server } from 'node:http';
import type { OnboardingStateDto } from './dto/onboarding.dto';
import type { integrations } from '../../infrastructure/database/schema';

describe('GET /api/onboarding/state sending availability', () => {
  let app: INestApplication;
  let source: typeof integrations.$inferSelect;
  let used = 0;
  beforeAll(async () => {
    const registry = seededTemplateRegistry();
    const stateService = new OnboardingStateService(
      {} as never,
      {} as never,
      registry,
    );
    const state = {
      resolveCurrentIntegration: () => Promise.resolve(source),
      prefillStoreNameIfMissing: () => Promise.resolve(source),
      toState: (record: typeof source) => stateService.toState(record),
    };
    const entitlement = new BillingEntitlementService({
      getEntitlementSource: () => Promise.resolve(source),
      getIntegrationUsageForPeriod: () =>
        Promise.resolve({ consumedCount: used }),
    } as never);
    const availability = new SendingAvailabilityService(
      entitlement,
      {
        countMissedOrders: () =>
          Promise.resolve({
            count: 0,
            since: '2026-11-10T00:00:00Z',
            until: '2026-11-12T00:00:00Z',
          }),
      } as never,
      {
        resolvePlan: (id: 'pro') =>
          resolveBillingPlan({
            planId: id,
            currencyCode: 'USD',
            testMode: true,
          }),
      } as never,
    );
    const service = new OnboardingService(
      state as never,
      {} as never,
      entitlement,
      { readStatus: () => Promise.resolve(null) } as never,
      registry,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      availability,
    );
    const module = await Test.createTestingModule({
      controllers: [OnboardingController],
      providers: [{ provide: OnboardingService, useValue: service }],
    })
      .overrideGuard(DualAuthGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          context.switchToHttp().getRequest<{ user: object }>().user = {
            orgId: 'org-1',
            userId: 'owner',
            source: 'shopify',
            role: 'owner',
            shop: 'synthetic.myshopify.com',
          };
          return true;
        },
      })
      .compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(() => app.close());
  beforeEach(() => {
    source = {
      id: 'source-1',
      orgId: 'org-1',
      platformType: 'shopify',
      isActive: true,
      storeName: 'Synthetic',
      defaultLanguage: 'ar',
      onboardingStatus: 'completed',
      isAutoVerifyEnabled: true,
      billingStatus: null,
      billingPlanId: null,
      billingActivatedAt: null,
    } as typeof source;
    used = 0;
  });
  it.each([
    [null, null, true, 0, 'billing_not_active'],
    ['pro', 'cancelled', true, 0, 'billing_not_active'],
    ['pro', 'active', true, 0, null],
    ['pro', 'active', true, 1000, 'plan_limit_reached'],
    ['pro', 'active', false, 0, 'integration_inactive'],
  ])(
    'returns the authoritative reason for %s/%s',
    async (plan, status, active, consumption, reason) => {
      Object.assign(source, {
        billingPlanId: plan,
        billingStatus: status,
        isActive: active,
      });
      used = consumption;
      const response = await request(app.getHttpServer() as Server)
        .get('/api/onboarding/state')
        .expect(200);
      expect(
        (response.body as { state: OnboardingStateDto }).state
          .sendingAvailability,
      ).toMatchObject({
        available: reason === null,
        reason,
        lastPlanId: plan,
      });
      if (status === 'cancelled')
        expect(
          (response.body as { state: OnboardingStateDto }).state.usage,
        ).toBeNull();
    },
  );
  it.each(['standalone', 'easyorders', 'woocommerce'])(
    'does not expose the Shopify feature to %s',
    async (platform) => {
      source.platformType = platform;
      const response = await request(app.getHttpServer() as Server)
        .get('/api/onboarding/state')
        .expect(200);
      expect(
        (response.body as { state: OnboardingStateDto }).state,
      ).not.toHaveProperty('sendingAvailability');
    },
  );
});
