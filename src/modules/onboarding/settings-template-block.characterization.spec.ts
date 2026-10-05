import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { usageAccountingFixture } from '../../../test/contracts/usage-accounting-fixture';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { BillingEntitlementService } from '../verification-core/billing-entitlement.service';
import { OnboardingTestService } from '../verifications/onboarding-test.service';
import { OnboardingService } from './onboarding.service';

/**
 * US-08-03 characterization of what a merchant sees: the `template` block of
 * `GET /api/settings` and the preview and sample of the onboarding test.
 *
 * Every case runs the real services and compares the result with the one
 * recorded from `develop` while the code catalog was still the source. The
 * fixture was recorded once and this spec only compares: a difference means
 * Settings or the onboarding test would look different, so the fix is in the
 * code, never in the fixture.
 *
 * The comparison is on `JSON.stringify`, so key order and value types count.
 */
const FIXTURE_PATH = resolve(
  __dirname,
  '../../../test/fixtures/whatsapp-templates/settings/baseline.json',
);

const ARABIC_PHONE = '+201148675077';
const NON_ARABIC_PHONE = '+14155550101';

interface StoreCase {
  name: string;
  store: {
    defaultLanguage: string;
    codTemplateArVariant: string | null;
    codTemplateEnVariant: string | null;
    merchantWhatsappPhone: string | null;
    storeName: string | null;
    shippingCurrency: string | null;
  };
}

const DEFAULT_STORE: StoreCase['store'] = {
  defaultLanguage: 'auto',
  codTemplateArVariant: 'standard',
  codTemplateEnVariant: 'friendly',
  merchantWhatsappPhone: ARABIC_PHONE,
  storeName: 'Akeed Fashion',
  shippingCurrency: 'egp',
};

const STYLES = [
  { language: 'ar', style: 'standard' },
  { language: 'ar', style: 'egyptian' },
  { language: 'ar', style: 'gulf' },
  { language: 'ar', style: 'short' },
  { language: 'en', style: 'friendly' },
  { language: 'en', style: 'professional' },
  { language: 'en', style: 'direct' },
  { language: 'en', style: 'short' },
] as const;

const CASES: StoreCase[] = [
  ...STYLES.map(
    ({ language, style }): StoreCase => ({
      name: `${language}.${style}`,
      store: {
        ...DEFAULT_STORE,
        // Forced, so the onboarding test previews the style under test.
        defaultLanguage: language,
        ...(language === 'ar'
          ? { codTemplateArVariant: style }
          : { codTemplateEnVariant: style }),
      },
    }),
  ),
  { name: 'auto/arabic-phone', store: DEFAULT_STORE },
  {
    name: 'auto/non-arabic-phone',
    store: { ...DEFAULT_STORE, merchantWhatsappPhone: NON_ARABIC_PHONE },
  },
  {
    name: 'auto/no-phone-no-names',
    store: {
      ...DEFAULT_STORE,
      merchantWhatsappPhone: null,
      storeName: null,
      shippingCurrency: null,
    },
  },
  {
    name: 'ar/unknown-stored-variant',
    store: {
      ...DEFAULT_STORE,
      defaultLanguage: 'ar',
      codTemplateArVariant: 'retired_variant',
    },
  },
  {
    name: 'en/missing-stored-variant',
    store: {
      ...DEFAULT_STORE,
      defaultLanguage: 'en',
      codTemplateEnVariant: null,
    },
  },
];

const owner: AuthenticatedUser = {
  userId: 'user-1',
  orgId: 'org-1',
  role: 'owner',
  source: 'supabase',
};

function integrationFor(definition: StoreCase) {
  return {
    id: 'int-1',
    orgId: 'org-1',
    platformType: 'shopify',
    platformStoreUrl: 'merchant.myshopify.com',
    isActive: true,
    billingStatus: 'active',
    billingPlanId: 'basic',
    billingActivatedAt: '2026-05-01T00:00:00.000Z',
    onboardingStatus: 'completed',
    isAutoVerifyEnabled: true,
    ...definition.store,
  };
}

function buildSettingsService(definition: StoreCase): OnboardingService {
  const integration = integrationFor(definition);
  return new OnboardingService(
    {
      resolveCurrentIntegration: jest.fn().mockResolvedValue(integration),
      prefillStoreNameIfMissing: jest.fn().mockResolvedValue(integration),
      toState: jest.fn().mockReturnValue({ integrationId: 'int-1' }),
    } as never,
    {
      getBillingPlans: jest
        .fn()
        .mockResolvedValue({ plans: [], isFreePlanClaimed: false }),
    } as never,
    new BillingEntitlementService(
      {
        getEntitlementSource: jest.fn().mockResolvedValue(integration),
        getIntegrationUsageForPeriod: jest
          .fn()
          .mockResolvedValue({ consumedCount: 0, includedLimit: 300 }),
      } as never,
      usageAccountingFixture(),
    ),
    { readStatus: jest.fn().mockResolvedValue(null) } as never,
  );
}

function buildOnboardingTestService(
  definition: StoreCase,
): OnboardingTestService {
  return new OnboardingTestService(
    {
      findActiveByOrg: jest
        .fn()
        .mockResolvedValue([integrationFor(definition)]),
    } as never,
    { findByIdForOrg: jest.fn() } as never,
    { handleSyntheticTestOrder: jest.fn() } as never,
    {
      findLatest: jest.fn().mockResolvedValue(undefined),
      countSince: jest.fn().mockResolvedValue(0),
    } as never,
    { findCurrent: jest.fn().mockResolvedValue(undefined) } as never,
  );
}

async function observe(definition: StoreCase) {
  const settings = await buildSettingsService(definition).getSettings(owner);
  const test = await buildOnboardingTestService(definition).getStatus(owner);
  return {
    settingsTemplate: settings.template,
    onboardingTest: {
      language: test.language,
      preview: test.preview,
      sample: test.sample,
    },
  };
}

interface Baseline {
  cases: Record<string, unknown>;
}

describe('Settings template block characterization', () => {
  const baseline = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Baseline;

  it('covers exactly the recorded cases', () => {
    expect(Object.keys(baseline.cases)).toEqual(CASES.map(({ name }) => name));
  });

  it.each(CASES)(
    'returns the recorded blocks for $name',
    async (definition) => {
      expect(JSON.stringify(await observe(definition))).toBe(
        JSON.stringify(baseline.cases[definition.name]),
      );
    },
  );
});
