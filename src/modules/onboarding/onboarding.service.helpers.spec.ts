import {
  resolveIncludedVerificationsLimit,
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

    it('returns 300 for basic', () => {
      expect(resolveIncludedVerificationsLimit('basic')).toBe(300);
    });

    it('returns 1000 for pro', () => {
      expect(resolveIncludedVerificationsLimit('pro')).toBe(1000);
    });

    it('returns 2500 for business', () => {
      expect(resolveIncludedVerificationsLimit('business')).toBe(2500);
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
      });
    });

    it('resolves basic plan without usage billing', () => {
      const plan = resolveBillingPlan({
        planId: 'basic',
        ...defaultParams,
      });
      expect(plan.id).toBe('basic');
      expect(plan.name).toBe('Akeed Basic');
      expect(plan.amount).toBe(8.99);
      expect(plan.includedVerifications).toBe(300);
    });

    it('resolves pro plan without usage billing', () => {
      const plan = resolveBillingPlan({
        planId: 'pro',
        ...defaultParams,
      });
      expect(plan.id).toBe('pro');
      expect(plan.name).toBe('Akeed Pro');
      expect(plan.amount).toBe(22.99);
      expect(plan.includedVerifications).toBe(1000);
    });

    it('resolves business plan as public Scale plan without usage billing', () => {
      const plan = resolveBillingPlan({
        planId: 'business',
        ...defaultParams,
      });
      expect(plan.id).toBe('business');
      expect(plan.name).toBe('Akeed Scale');
      expect(plan.amount).toBe(44.99);
      expect(plan.includedVerifications).toBe(2500);
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
