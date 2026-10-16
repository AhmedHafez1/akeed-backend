import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { usageAccountingFixture } from '../../../test/contracts/usage-accounting-fixture';
import { MESSAGE_IMPROVEMENT_SWITCHES_OFF } from '../../shared/config/whatsapp-template.config';
import {
  authoredTemplate,
  reminderTemplate,
  seededRegistryTemplates,
  seededTemplateRegistry,
} from '../../shared/messaging/testing/seeded-template-registry';
import type { RegistryTemplate } from '../../shared/messaging/template-registry.types';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { BillingEntitlementService } from '../verification-core/billing-entitlement.service';
import { UpdateOnboardingSettingsDto } from './dto/onboarding.dto';
import { OnboardingStateService } from './onboarding-state.service';
import { OnboardingService } from './onboarding.service';

/**
 * Urdu, Spanish, French and Turkish in Settings: what a merchant sees and may
 * save before and after a language has an approved default template.
 */
const owner: AuthenticatedUser = {
  userId: 'user-1',
  orgId: 'org-1',
  role: 'owner',
  source: 'supabase',
};

const FORM = {
  storeName: 'Akeed Fashion',
  defaultLanguage: 'auto' as const,
  isAutoVerifyEnabled: true,
};

const URDU_IN_REVIEW = authoredTemplate('ur', 'standard_v1');
const URDU_APPROVED_OFF = authoredTemplate('ur', 'short_v1', {
  reviewStatus: 'approved',
});
const URDU_REJECTED = authoredTemplate('ur', 'formal_v1', {
  reviewStatus: 'rejected',
});
const AWAITING = [
  ...seededRegistryTemplates(),
  URDU_IN_REVIEW,
  URDU_APPROVED_OFF,
  URDU_REJECTED,
];
const URDU_LIVE = [
  ...seededRegistryTemplates(),
  authoredTemplate('ur', 'standard_v1', {
    isActive: true,
    isDefault: true,
    reviewStatus: 'approved',
  }),
  authoredTemplate('ur', 'short_v1', {
    isActive: true,
    reviewStatus: 'approved',
  }),
  authoredTemplate('ur', 'formal_v1'),
  reminderTemplate('ur', 'standard_v1', { isDefault: true }),
];

function setup(
  templates: RegistryTemplate[],
  stored: Record<string, unknown> = {},
  reminderTemplateOn = false,
  retiredKeys: readonly string[] = [],
) {
  const switches = {
    current: () => ({
      ...MESSAGE_IMPROVEMENT_SWITCHES_OFF,
      reminderTemplate: reminderTemplateOn,
    }),
  };
  let row: Record<string, unknown> = {
    id: 'int-1',
    orgId: 'org-1',
    platformType: 'standalone',
    platformStoreUrl: 'standalone:org-1',
    isActive: true,
    billingStatus: 'active',
    storeName: 'Akeed Fashion',
    defaultLanguage: 'auto',
    isAutoVerifyEnabled: true,
    onboardingStatus: 'completed',
    followUpEnabled: true,
    followUpDelayMinutes: 120,
    escalationEnabled: true,
    escalationDelayMinutes: 360,
    quietHoursEnabled: false,
    codTemplateArVariant: 'standard',
    codTemplateEnVariant: 'friendly',
    merchantWhatsappPhone: null,
    ...stored,
  };
  const integrationsRepo = {
    findActiveByOrg: jest.fn(() => Promise.resolve([row])),
    updateById: jest.fn((_id: string, updates: Record<string, unknown>) => {
      row = { ...row, ...updates };
      return Promise.resolve(row);
    }),
  };
  const registry = seededTemplateRegistry(templates, { retiredKeys });
  const state = new OnboardingStateService(
    integrationsRepo as never,
    {} as never,
    registry,
    undefined,
    undefined,
    undefined,
    undefined,
    switches as never,
  );
  const settings = new OnboardingService(
    state,
    {
      getBillingPlans: jest
        .fn()
        .mockResolvedValue({ plans: [], isFreePlanClaimed: false }),
    } as never,
    new BillingEntitlementService(
      {
        getEntitlementSource: jest.fn(() => Promise.resolve(row)),
        getIntegrationUsageForPeriod: jest
          .fn()
          .mockResolvedValue({ consumedCount: 0, includedLimit: 300 }),
      } as never,
      usageAccountingFixture(),
    ),
    { readStatus: jest.fn().mockResolvedValue(null) } as never,
    registry,
    undefined,
    undefined,
    undefined,
    undefined,
    switches as never,
  );
  return { settings, integrationsRepo, current: () => row };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(BadRequestException);
  return (error as BadRequestException).getResponse();
}

describe('a language awaiting approval, in Settings', () => {
  it('lists its templates as locked and leaves out the rejected one', async () => {
    const { template } = await setup(AWAITING).settings.getSettings(owner);

    expect(template.languages).toEqual(['ar', 'en', 'ur', 'es', 'fr', 'tr']);
    expect(template.liveLanguages).toEqual(['ar', 'en']);
    expect(
      template.variants.ur.map(({ variant, language, availability }) => ({
        variant,
        language,
        availability,
      })),
    ).toEqual([
      { variant: 'standard_v1', language: 'ur', availability: 'in_review' },
      { variant: 'short_v1', language: 'ur', availability: 'not_enabled' },
    ]);
    expect(template.variants.ur[0].message.direction).toBe('rtl');
    expect(template.defaults.ur).toBeNull();
    expect(template.selected.ur).toBeNull();
    expect(template.messages.ur).toBeNull();
  });

  it('leaves out a template staff retired', async () => {
    const { template } = await setup(AWAITING, {}, false, [
      URDU_APPROVED_OFF.key,
    ]).settings.getSettings(owner);
    expect(template.variants.ur.map(({ variant }) => variant)).toEqual([
      'standard_v1',
    ]);
  });

  it('leaves Arabic and English styles without an availability', async () => {
    const { template } = await setup(AWAITING).settings.getSettings(owner);
    for (const style of [...template.variants.ar, ...template.variants.en]) {
      expect(style).not.toHaveProperty('availability');
    }
  });

  it('refuses to set the store to it', async () => {
    const { settings, integrationsRepo } = setup(AWAITING);
    expect(
      await rejection(
        settings.updateSettingsResponse(owner, {
          ...FORM,
          defaultLanguage: 'ur',
        }),
      ),
    ).toMatchObject({ code: 'SETTINGS_LANGUAGE_UNAVAILABLE' });
    expect(integrationsRepo.updateById).not.toHaveBeenCalled();
  });

  it('refuses to choose a locked template, in review or approved', async () => {
    const { settings, integrationsRepo } = setup(AWAITING);
    for (const codTemplateUrVariant of ['standard_v1', 'short_v1']) {
      expect(
        await rejection(
          settings.updateSettingsResponse(owner, {
            ...FORM,
            codTemplateUrVariant,
          }),
        ),
      ).toMatchObject({
        code: 'SETTINGS_TEMPLATE_STYLE_UNAVAILABLE',
        message: 'Unsupported Urdu COD template variant',
      });
    }
    expect(integrationsRepo.updateById).not.toHaveBeenCalled();
  });

  it('still saves Arabic, English and auto as before', async () => {
    const { settings, current } = setup(AWAITING);
    await settings.updateSettingsResponse(owner, {
      ...FORM,
      defaultLanguage: 'ar',
      codTemplateArVariant: 'gulf',
    });
    expect(current()).toMatchObject({
      defaultLanguage: 'ar',
      codTemplateArKey: 'cod_confirm.ar.gulf',
      codTemplateArVariant: 'gulf',
    });
  });
});

describe('a live language, in Settings', () => {
  it('offers its active styles only, like Arabic and English', async () => {
    const { template } = await setup(URDU_LIVE).settings.getSettings(owner);

    expect(template.liveLanguages).toEqual(['ar', 'en', 'ur']);
    expect(template.variants.ur.map(({ variant }) => variant)).toEqual([
      'standard_v1',
      'short_v1',
    ]);
    for (const style of template.variants.ur) {
      expect(style).not.toHaveProperty('availability');
    }
    expect(template.defaults.ur).toBe('standard_v1');
    expect(template.selected.ur).toBe('standard_v1');
    expect(template.messages.ur?.direction).toBe('rtl');
  });

  it('saves the store language and the style under the language own key', async () => {
    const { settings, current } = setup(URDU_LIVE);
    const saved = await settings.updateSettingsResponse(owner, {
      ...FORM,
      defaultLanguage: 'ur',
      codTemplateUrVariant: 'short_v1',
    });

    expect(current()).toMatchObject({
      defaultLanguage: 'ur',
      codTemplateUrKey: 'cod_confirm.ur.short_v1',
      codTemplateArVariant: 'standard',
      codTemplateEnVariant: 'friendly',
    });
    expect(current()).not.toHaveProperty('codTemplateArKey');
    expect(saved.template.selected.ur).toBe('short_v1');
    expect(saved.state.testSendLanguage).toBe('ur');
  });

  it('saves and clears its reminder while the reminder switch is on', async () => {
    const { settings, current } = setup(URDU_LIVE, {}, true);
    const saved = await settings.updateSettingsResponse(owner, {
      ...FORM,
      codReminderUrVariant: 'standard_v1',
    });
    expect(current().codReminderUrKey).toBe('cod_reminder.ur.standard_v1');
    expect(saved.template.reminder?.selected.ur).toBe('standard_v1');

    await settings.updateSettingsResponse(owner, {
      ...FORM,
      codReminderUrVariant: null,
    });
    expect(current().codReminderUrKey).toBeNull();
  });

  it('keeps a store on a language that later lost its default', async () => {
    const { settings, current } = setup(AWAITING, { defaultLanguage: 'ur' });
    await settings.updateSettingsResponse(owner, {
      ...FORM,
      defaultLanguage: 'ur',
      storeName: 'Renamed',
    });
    expect(current()).toMatchObject({
      defaultLanguage: 'ur',
      storeName: 'Renamed',
    });
  });

  it('reads the test language of an auto store from its number', async () => {
    const { settings } = setup(URDU_LIVE, {
      merchantWhatsappPhone: '+923001234567',
    });
    const response = await settings.getSettings(owner);
    expect(response.state.testSendLanguage).toBe('ur');
  });
});

describe('Turkish, in Settings', () => {
  const TURKISH_LIVE = [
    ...seededRegistryTemplates(),
    authoredTemplate('tr', 'standard_v1', {
      isActive: true,
      isDefault: true,
      reviewStatus: 'approved',
    }),
    authoredTemplate('tr', 'short_v1', {
      isActive: true,
      reviewStatus: 'approved',
    }),
  ];

  it('is not live while it has drafts only, and offers nothing to choose', async () => {
    // The migration writes drafts only, so the registry holds no Turkish row.
    const { template } = await setup(
      seededRegistryTemplates(),
    ).settings.getSettings(owner);
    expect(template.liveLanguages).not.toContain('tr');
    expect(template.variants.tr).toEqual([]);
    expect(template.defaults.tr).toBeNull();
    expect(template.selected.tr).toBeNull();
    expect(template.messages.tr).toBeNull();
  });

  it('refuses to set the store to it while it has drafts only', async () => {
    const { settings, integrationsRepo } = setup(seededRegistryTemplates());
    expect(
      await rejection(
        settings.updateSettingsResponse(owner, {
          ...FORM,
          defaultLanguage: 'tr',
        }),
      ),
    ).toMatchObject({ code: 'SETTINGS_LANGUAGE_UNAVAILABLE' });
    expect(integrationsRepo.updateById).not.toHaveBeenCalled();
  });

  it('lists a submitted template awaiting review as locked', async () => {
    const { template } = await setup([
      ...seededRegistryTemplates(),
      authoredTemplate('tr', 'standard_v1'),
    ]).settings.getSettings(owner);
    expect(template.liveLanguages).not.toContain('tr');
    expect(
      template.variants.tr.map(({ variant, availability }) => ({
        variant,
        availability,
      })),
    ).toEqual([{ variant: 'standard_v1', availability: 'in_review' }]);
  });

  it('is live with two approved active templates and a default', async () => {
    const { template } = await setup(TURKISH_LIVE).settings.getSettings(owner);
    expect(template.liveLanguages).toEqual(['ar', 'en', 'tr']);
    expect(template.variants.tr.map(({ variant }) => variant)).toEqual([
      'standard_v1',
      'short_v1',
    ]);
    for (const style of template.variants.tr) {
      expect(style).not.toHaveProperty('availability');
    }
    expect(template.defaults.tr).toBe('standard_v1');
    expect(template.messages.tr?.direction).toBe('ltr');
  });

  it('saves the store language and the style under the Turkish key', async () => {
    const { settings, current } = setup(TURKISH_LIVE);
    await settings.updateSettingsResponse(owner, {
      ...FORM,
      defaultLanguage: 'tr',
      codTemplateTrVariant: 'short_v1',
    });
    expect(current()).toMatchObject({
      defaultLanguage: 'tr',
      codTemplateTrKey: 'cod_confirm.tr.short_v1',
    });
  });

  it('reads the test language of an auto store with a +90 number', async () => {
    const live = await setup(TURKISH_LIVE, {
      merchantWhatsappPhone: '+905321234567',
    }).settings.getSettings(owner);
    expect(live.state.testSendLanguage).toBe('tr');

    const draftsOnly = await setup(seededRegistryTemplates(), {
      merchantWhatsappPhone: '+905321234567',
    }).settings.getSettings(owner);
    expect(draftsOnly.state.testSendLanguage).toBe('en');
  });
});

describe('UpdateOnboardingSettingsDto', () => {
  it('accepts the new languages and their style fields', async () => {
    const dto = plainToInstance(UpdateOnboardingSettingsDto, {
      ...FORM,
      defaultLanguage: 'fr',
      codTemplateUrVariant: 'standard_v1',
      codTemplateEsVariant: 'short_v1',
      codTemplateFrVariant: 'standard_v1',
      codReminderUrVariant: null,
      codReminderEsVariant: 'standard_v1',
      codReminderFrVariant: null,
      codTemplateTrVariant: 'short_v1',
      codReminderTrVariant: 'standard_v1',
    });
    expect(await validate(dto)).toEqual([]);
  });

  it('refuses a language Akeed does not send', async () => {
    const dto = plainToInstance(UpdateOnboardingSettingsDto, {
      ...FORM,
      defaultLanguage: 'de',
    });
    expect((await validate(dto)).map((error) => error.property)).toEqual([
      'defaultLanguage',
    ]);
  });
});
