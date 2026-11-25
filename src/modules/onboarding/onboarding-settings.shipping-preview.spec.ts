import { usageAccountingFixture } from '../../../test/contracts/usage-accounting-fixture';
import type { RegistryTemplate } from '../../shared/messaging/template-registry.types';
import { seededTemplateRegistry } from '../../shared/messaging/testing/seeded-template-registry';
import { TemplateMessageService } from '../template-registry/template-message.service';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { BillingEntitlementService } from '../verification-core/billing-entitlement.service';
import { OnboardingService } from './onboarding.service';

const owner: AuthenticatedUser = {
  userId: 'user-1',
  orgId: 'org-1',
  role: 'owner',
  source: 'supabase',
};

const integration = {
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
  defaultLanguage: 'auto',
  codTemplateArVariant: 'standard',
  codTemplateEnVariant: 'friendly',
  merchantWhatsappPhone: '+201148675077',
  storeName: 'Akeed Fashion',
  shippingCurrency: 'egp',
};

async function shippingRegistry(
  overrides: Partial<RegistryTemplate> = {},
): Promise<{ templates: RegistryTemplate[]; shipped: RegistryTemplate }> {
  const seeded = await seededTemplateRegistry().listTemplates();
  const english = seeded.find(
    (template) => template.language === 'en' && template.isDefault,
  );
  if (!english) throw new Error('seeded English default missing');
  const shipped: RegistryTemplate = {
    ...english,
    key: 'shipping_shipped.en.default',
    purpose: 'shipping_shipped',
    reviewStatus: 'pending',
    isDefault: true,
    isActive: true,
    ...overrides,
  };
  return { templates: [...seeded, shipped], shipped };
}

function settingsService(
  state: Record<string, unknown>,
  templates: readonly RegistryTemplate[],
): OnboardingService {
  const registry = seededTemplateRegistry();
  return new OnboardingService(
    {
      resolveCurrentIntegration: jest.fn().mockResolvedValue(integration),
      prefillStoreNameIfMissing: jest.fn().mockResolvedValue(integration),
      toState: jest.fn().mockReturnValue({ integrationId: 'int-1', ...state }),
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
    {
      readStatus: jest.fn().mockResolvedValue(null),
      messagePrices: () => ({
        akeedMessagePriceMinor: 100,
        ownNumberMessagePriceMinor: 50,
      }),
    } as never,
    Object.assign(Object.create(registry) as object, {
      listTemplates: () => Promise.resolve(templates),
    }) as never,
  );
}

describe('GET /api/settings: Shipped message preview', () => {
  it('is absent while the state carries no shipping fields', async () => {
    const { templates } = await shippingRegistry();
    const settings = await settingsService({}, templates).getSettings(owner);
    expect(settings).not.toHaveProperty('shipping');
  });

  it('previews the default Shipped message per language, even before approval', async () => {
    const { templates, shipped } = await shippingRegistry();
    const settings = await settingsService(
      {
        shippingNotificationsEnabled: false,
        shippingFulfillmentTriggerEnabled: true,
        shippingTags: [],
      },
      templates,
    ).getSettings(owner);
    expect(settings.shipping?.messages.en).toEqual(
      new TemplateMessageService().linesFor(shipped),
    );
    for (const language of ['ar', 'ur', 'es', 'fr', 'tr'] as const)
      expect(settings.shipping?.messages[language]).toBeNull();
    expect(settings.shipping?.trackingSamples).toEqual({
      ar: 'للتتبع: 1Z999AA10123456784',
      en: 'Tracking: 1Z999AA10123456784',
      ur: 'ٹریکنگ: 1Z999AA10123456784',
      es: 'Seguimiento: 1Z999AA10123456784',
      fr: 'Suivi : 1Z999AA10123456784',
      tr: 'Kargo takibi: 1Z999AA10123456784',
    });
  });

  it('never previews an inactive or non-default Shipped template', async () => {
    for (const overrides of [{ isActive: false }, { isDefault: false }]) {
      const { templates } = await shippingRegistry(overrides);
      const settings = await settingsService(
        { shippingNotificationsEnabled: true },
        templates,
      ).getSettings(owner);
      expect(settings.shipping?.messages.en).toBeNull();
    }
  });

  it('leaves the confirmation preview unchanged', async () => {
    const { templates } = await shippingRegistry();
    const withShipping = await settingsService(
      { shippingNotificationsEnabled: true },
      templates,
    ).getSettings(owner);
    const without = await settingsService(
      {},
      await seededTemplateRegistry().listTemplates(),
    ).getSettings(owner);
    expect(withShipping.template).toEqual(without.template);
  });
});
