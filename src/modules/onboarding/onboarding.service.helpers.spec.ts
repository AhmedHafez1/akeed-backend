import {
  resolveIncludedVerificationsLimit,
  resolveOverageConfig,
  resolveBillingPlan,
  resolveBillingPlans,
  isOnboardingBillingPlanId,
  DEFAULT_BILLING_PLAN_ID,
  buildBillingReturnUrl,
  buildPostBillingRedirectUrl,
} from './onboarding.service.helpers';

describe('onboarding.service.helpers', () => {
  describe('isOnboardingBillingPlanId', () => {
    it.each(['starter', 'basic', 'pro', 'business'])(
      'returns true for valid plan id: %s',
      (planId) => {
        expect(isOnboardingBillingPlanId(planId)).toBe(true);
      },
    );

    it.each(['free', 'premium', 'enterprise', '', 'BASIC', 'Pro'])(
      'returns false for invalid plan id: %s',
      (planId) => {
        expect(isOnboardingBillingPlanId(planId)).toBe(false);
      },
    );
  });

  describe('DEFAULT_BILLING_PLAN_ID', () => {
    it('defaults to starter', () => {
      expect(DEFAULT_BILLING_PLAN_ID).toBe('starter');
    });
  });

  describe('resolveIncludedVerificationsLimit', () => {
    it('returns 30 for starter', () => {
      expect(resolveIncludedVerificationsLimit('starter')).toBe(30);
    });

    it('returns 200 for basic', () => {
      expect(resolveIncludedVerificationsLimit('basic')).toBe(200);
    });

    it('returns 500 for pro', () => {
      expect(resolveIncludedVerificationsLimit('pro')).toBe(500);
    });

    it('returns 1500 for business', () => {
      expect(resolveIncludedVerificationsLimit('business')).toBe(1500);
    });
  });

  describe('resolveOverageConfig', () => {
    it('returns null for starter (no overage)', () => {
      expect(resolveOverageConfig('starter')).toBeNull();
    });

    it('returns correct overage config for basic', () => {
      const config = resolveOverageConfig('basic');
      expect(config).toEqual({
        overageRate: 0.035,
        cappedAmount: 14,
      });
    });

    it('returns correct overage config for pro', () => {
      const config = resolveOverageConfig('pro');
      expect(config).toEqual({
        overageRate: 0.032,
        cappedAmount: 32,
      });
    });

    it('returns correct overage config for business', () => {
      const config = resolveOverageConfig('business');
      expect(config).toEqual({
        overageRate: 0.03,
        cappedAmount: 90,
      });
    });
  });

  describe('resolveBillingPlan', () => {
    const defaultParams = { currencyCode: 'USD', testMode: false };

    it('resolves starter plan correctly', () => {
      const plan = resolveBillingPlan({
        planId: 'starter',
        ...defaultParams,
      });
      expect(plan).toEqual({
        id: 'starter',
        name: 'Akeed Starter',
        amount: 0,
        currencyCode: 'USD',
        testMode: false,
        includedVerifications: 30,
        usage: undefined,
      });
    });

    it('resolves basic plan with usage terms', () => {
      const plan = resolveBillingPlan({
        planId: 'basic',
        ...defaultParams,
      });
      expect(plan.id).toBe('basic');
      expect(plan.name).toBe('Akeed Basic');
      expect(plan.amount).toBe(9.99);
      expect(plan.includedVerifications).toBe(200);
      expect(plan.usage).toBeDefined();
      expect(plan.usage!.cappedAmount).toBe(14);
      expect(plan.usage!.overageRate).toBe(0.035);
      expect(plan.usage!.terms).toContain('200');
      expect(plan.usage!.terms).toContain('0.035');
      expect(plan.usage!.terms).toContain('USD');
    });

    it('resolves pro plan with usage terms', () => {
      const plan = resolveBillingPlan({
        planId: 'pro',
        ...defaultParams,
      });
      expect(plan.id).toBe('pro');
      expect(plan.name).toBe('Akeed Pro');
      expect(plan.amount).toBe(18.99);
      expect(plan.includedVerifications).toBe(500);
      expect(plan.usage).toBeDefined();
      expect(plan.usage!.cappedAmount).toBe(32);
      expect(plan.usage!.overageRate).toBe(0.032);
    });

    it('resolves business plan with usage terms', () => {
      const plan = resolveBillingPlan({
        planId: 'business',
        ...defaultParams,
      });
      expect(plan.id).toBe('business');
      expect(plan.name).toBe('Akeed Business');
      expect(plan.amount).toBe(48.99);
      expect(plan.includedVerifications).toBe(1500);
      expect(plan.usage).toBeDefined();
      expect(plan.usage!.cappedAmount).toBe(90);
      expect(plan.usage!.overageRate).toBe(0.03);
    });

    it('passes testMode through', () => {
      const plan = resolveBillingPlan({
        planId: 'basic',
        currencyCode: 'USD',
        testMode: true,
      });
      expect(plan.testMode).toBe(true);
    });

    it('passes currencyCode through', () => {
      const plan = resolveBillingPlan({
        planId: 'pro',
        currencyCode: 'SAR',
        testMode: false,
      });
      expect(plan.currencyCode).toBe('SAR');
      expect(plan.usage!.terms).toContain('SAR');
    });
  });

  describe('resolveBillingPlans', () => {
    it('returns all four plans in order', () => {
      const plans = resolveBillingPlans({
        currencyCode: 'USD',
        testMode: false,
      });
      expect(plans).toHaveLength(4);
      expect(plans.map((p) => p.id)).toEqual([
        'starter',
        'basic',
        'pro',
        'business',
      ]);
    });

    it('each plan has valid structure', () => {
      const plans = resolveBillingPlans({
        currencyCode: 'USD',
        testMode: false,
      });
      for (const plan of plans) {
        expect(plan.amount).toBeGreaterThanOrEqual(0);
        expect(plan.includedVerifications).toBeGreaterThan(0);
        expect(plan.currencyCode).toBe('USD');
      }
    });
  });

  describe('buildBillingReturnUrl', () => {
    it('builds correct return URL with shop', () => {
      const url = buildBillingReturnUrl(
        'https://api.akeed.co',
        'test.myshopify.com',
      );
      expect(url).toBe(
        'https://api.akeed.co/api/onboarding/billing/callback?shop=test.myshopify.com',
      );
    });

    it('includes host parameter when provided', () => {
      const url = buildBillingReturnUrl(
        'https://api.akeed.co',
        'test.myshopify.com',
        'abc123',
      );
      expect(url).toContain('shop=test.myshopify.com');
      expect(url).toContain('host=abc123');
    });
  });

  describe('buildPostBillingRedirectUrl', () => {
    it('builds URL with shop param', () => {
      const url = buildPostBillingRedirectUrl('https://app.akeed.co', {
        shop: 'test.myshopify.com',
      });
      expect(url).toContain('shop=test.myshopify.com');
    });

    it('includes host when provided', () => {
      const url = buildPostBillingRedirectUrl('https://app.akeed.co', {
        shop: 'test.myshopify.com',
        host: 'abc123',
      });
      expect(url).toContain('shop=test.myshopify.com');
      expect(url).toContain('host=abc123');
    });
  });
});
