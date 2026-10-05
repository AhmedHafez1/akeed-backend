import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { usageAccountingFixture } from '../../../test/contracts/usage-accounting-fixture';
import {
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
 * US-08-03: a store's style is a registry key. These specs save a style
 * through the settings write and read it back through the settings response,
 * over one in-memory integration row.
 */
const owner: AuthenticatedUser = {
  userId: 'user-1',
  orgId: 'org-1',
  role: 'owner',
  source: 'supabase',
};

const STYLES = [
  ['ar', 'standard'],
  ['ar', 'egyptian'],
  ['ar', 'gulf'],
  ['ar', 'short'],
  ['en', 'friendly'],
  ['en', 'professional'],
  ['en', 'direct'],
  ['en', 'short'],
] as const;

const FORM = {
  storeName: 'Akeed Fashion',
  defaultLanguage: 'auto' as const,
  isAutoVerifyEnabled: true,
};

function setup(
  templates: RegistryTemplate[] = seededRegistryTemplates(),
  stored: Record<string, unknown> = {},
) {
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
    codTemplateArKey: null,
    codTemplateEnKey: null,
    ...stored,
  };
  const integrationsRepo = {
    findActiveByOrg: jest.fn(() => Promise.resolve([row])),
    updateById: jest.fn((_id: string, updates: Record<string, unknown>) => {
      row = { ...row, ...updates };
      return Promise.resolve(row);
    }),
  };
  const registry = seededTemplateRegistry(templates);
  const state = new OnboardingStateService(
    integrationsRepo as never,
    {} as never,
    registry,
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
  );
  return { state, settings, integrationsRepo, current: () => row };
}

function payloadFor(language: 'ar' | 'en', style: string) {
  return {
    ...FORM,
    ...(language === 'ar'
      ? { codTemplateArVariant: style }
      : { codTemplateEnVariant: style }),
  };
}

async function expectStyleRejected(
  promise: Promise<unknown>,
  message: string,
): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(BadRequestException);
  expect((error as BadRequestException).getResponse()).toEqual({
    statusCode: 400,
    error: 'Bad Request',
    message,
    code: 'SETTINGS_TEMPLATE_STYLE_UNAVAILABLE',
  });
}

describe('template style settings', () => {
  it.each(STYLES)(
    'saves %s.%s as its registry key and reads it back as selected',
    async (language, style) => {
      const { settings, current } = setup();

      const response = await settings.updateSettingsResponse(
        owner,
        payloadFor(language, style),
      );

      const keyColumn =
        language === 'ar' ? 'codTemplateArKey' : 'codTemplateEnKey';
      expect(current()[keyColumn]).toBe(`cod_confirm.${language}.${style}`);
      expect(response.template.selected[language]).toBe(style);
      expect(response.template.previews[language]).toEqual(
        response.template.variants[language].find(
          ({ variant }) => variant === style,
        )?.preview,
      );
    },
  );

  it.each(STYLES)(
    'keeps the old variant column in step when %s.%s is saved',
    async (language, style) => {
      const { state, integrationsRepo } = setup();

      await state.updateSettings(owner, payloadFor(language, style));

      expect(integrationsRepo.updateById).toHaveBeenCalledWith(
        'int-1',
        expect.objectContaining(
          language === 'ar'
            ? {
                codTemplateArKey: `cod_confirm.ar.${style}`,
                codTemplateArVariant: style,
              }
            : {
                codTemplateEnKey: `cod_confirm.en.${style}`,
                codTemplateEnVariant: style,
              },
        ),
      );
    },
  );

  it('leaves both styles alone when the payload names neither', async () => {
    const { state, integrationsRepo } = setup();

    await state.updateSettings(owner, FORM);

    const [, updates] = integrationsRepo.updateById.mock.calls[0];
    expect(updates).not.toHaveProperty('codTemplateArKey');
    expect(updates).not.toHaveProperty('codTemplateEnKey');
    expect(updates).not.toHaveProperty('codTemplateArVariant');
    expect(updates).not.toHaveProperty('codTemplateEnVariant');
  });

  it('rejects an unknown style', async () => {
    const { state, integrationsRepo } = setup();

    await expectStyleRejected(
      state.updateSettings(owner, payloadFor('ar', 'retired_style')),
      'Unsupported Arabic COD template variant',
    );
    expect(integrationsRepo.updateById).not.toHaveBeenCalled();
  });

  it('rejects an inactive style', async () => {
    const { state, integrationsRepo } = setup(
      seededRegistryTemplates().map((template) =>
        template.key === 'cod_confirm.en.direct'
          ? { ...template, isActive: false }
          : template,
      ),
    );

    await expectStyleRejected(
      state.updateSettings(owner, payloadFor('en', 'direct')),
      'Unsupported English COD template variant',
    );
    expect(integrationsRepo.updateById).not.toHaveBeenCalled();
  });

  it.each([
    ['ar', 'friendly', 'Unsupported Arabic COD template variant'],
    ['en', 'gulf', 'Unsupported English COD template variant'],
  ] as const)(
    'rejects a style of the other language (%s: %s)',
    async (language, style, message) => {
      const { state, integrationsRepo } = setup();

      await expectStyleRejected(
        state.updateSettings(owner, payloadFor(language, style)),
        message,
      );
      expect(integrationsRepo.updateById).not.toHaveBeenCalled();
    },
  );

  it('saves a style the old variant column cannot hold without touching that column', async () => {
    const added: RegistryTemplate = {
      ...seededRegistryTemplates()[0],
      key: 'cod_confirm.ar.levantine',
      style: 'levantine',
      isDefault: false,
    };
    const { settings, integrationsRepo, current } = setup([
      ...seededRegistryTemplates(),
      added,
    ]);

    const response = await settings.updateSettingsResponse(
      owner,
      payloadFor('ar', 'levantine'),
    );

    const [, updates] = integrationsRepo.updateById.mock.calls[0];
    expect(updates).not.toHaveProperty('codTemplateArVariant');
    expect(current().codTemplateArKey).toBe('cod_confirm.ar.levantine');
    expect(response.template.selected.ar).toBe('levantine');
    expect(response.template.variants.ar.map(({ variant }) => variant)).toEqual(
      ['standard', 'egyptian', 'gulf', 'short', 'levantine'],
    );
  });

  it('hides an inactive style and reads a store that chose it as the default', async () => {
    const { settings } = setup(
      seededRegistryTemplates().map((template) =>
        template.key === 'cod_confirm.ar.gulf'
          ? { ...template, isActive: false }
          : template,
      ),
      // Saved while the style was active.
      { codTemplateArKey: 'cod_confirm.ar.gulf', codTemplateArVariant: 'gulf' },
    );

    const response = await settings.getSettings(owner);

    expect(response.template.variants.ar.map(({ variant }) => variant)).toEqual(
      ['standard', 'egyptian', 'short'],
    );
    expect(response.template.selected.ar).toBe('standard');
  });

  describe('request validation', () => {
    async function errorsFor(payload: Record<string, unknown>) {
      return validate(
        plainToInstance(UpdateOnboardingSettingsDto, { ...FORM, ...payload }),
      );
    }

    it('accepts any style id as text: the registry decides', async () => {
      await expect(
        errorsFor({ codTemplateArVariant: 'levantine' }),
      ).resolves.toHaveLength(0);
    });

    it.each([[''], [42], ['x'.repeat(65)]])(
      'rejects %p as a style id',
      async (value) => {
        const errors = await errorsFor({ codTemplateEnVariant: value });

        expect(errors.map(({ property }) => property)).toEqual([
          'codTemplateEnVariant',
        ]);
      },
    );
  });
});
