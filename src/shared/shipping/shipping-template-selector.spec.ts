import type {
  RegistryTemplate,
  TemplateLanguage,
} from '../messaging/template-registry.types';
import {
  seededRegistryTemplates,
  syncedApprovedTemplates,
} from '../messaging/testing/seeded-template-registry';
import { selectShippingTemplate } from './shipping-template-selector';

function shipped(
  language: TemplateLanguage,
  overrides: Partial<RegistryTemplate> = {},
): RegistryTemplate {
  return {
    key: `shipping_shipped.${language}.default`,
    purpose: 'shipping_shipped',
    language,
    style: 'default',
    templateName: 'akeed_shipping_shipped_default_v1',
    languageCode: language,
    parameterFormat: 'named',
    variables: [
      { key: 'customer', name: 'customer' },
      { key: 'order', name: 'order' },
      { key: 'store', name: 'store' },
      { key: 'tracking', name: 'tracking' },
    ],
    preview: {
      greeting: '',
      body: '',
      totalLabel: '',
      ending: '',
      confirmButton: 'I will be home',
      cancelButton: 'Reschedule',
      changeButton: 'Change address',
    },
    isActive: true,
    isDefault: true,
    reviewStatus: 'approved',
    category: 'utility',
    lastSyncedAt: '2026-11-24T00:00:00.000Z',
    ...overrides,
  };
}

/** A French store's confirmations: the French default is live. */
function frenchConfirmation(): RegistryTemplate {
  const [base] = syncedApprovedTemplates().filter(
    (template) => template.language === 'en' && template.isDefault,
  );
  return {
    ...base,
    key: 'cod_confirm.fr.standard_v1',
    language: 'fr',
    style: 'standard_v1',
    languageCode: 'fr',
  };
}

const EGYPT = '+201001234567';
const FRANCE = '+33612345678';
const US = '+12025550123';

describe('selectShippingTemplate', () => {
  it('uses the language the confirmation rules choose', () => {
    const selection = selectShippingTemplate(
      [...syncedApprovedTemplates(), shipped('ar'), shipped('en')],
      { phoneNumber: EGYPT },
    );
    expect(selection).toMatchObject({
      requestedLanguage: 'ar',
      template: { language: 'ar', registryKey: 'shipping_shipped.ar.default' },
    });
    expect(selection).not.toHaveProperty('fallbackReason');
  });

  it('follows a forced store language', () => {
    const selection = selectShippingTemplate(
      [...syncedApprovedTemplates(), shipped('ar'), shipped('en')],
      { phoneNumber: EGYPT, preferredLanguage: 'en' },
    );
    expect(selection.template?.language).toBe('en');
  });

  it('follows a live country language, as confirmations do', () => {
    const selection = selectShippingTemplate(
      [
        ...syncedApprovedTemplates(),
        frenchConfirmation(),
        shipped('fr'),
        shipped('en'),
      ],
      { phoneNumber: FRANCE },
    );
    expect(selection.template?.language).toBe('fr');
  });

  it('falls back to the base language when the chosen one has no approved Shipped template', () => {
    const selection = selectShippingTemplate(
      [
        ...syncedApprovedTemplates(),
        frenchConfirmation(),
        shipped('fr', { reviewStatus: 'pending' }),
        shipped('en'),
        shipped('ar'),
      ],
      { phoneNumber: FRANCE },
    );
    expect(selection).toMatchObject({
      requestedLanguage: 'fr',
      fallbackReason: 'language_unavailable',
      template: { language: 'en' },
    });
  });

  it('falls back from Arabic to English, then from English to Arabic', () => {
    expect(
      selectShippingTemplate([...syncedApprovedTemplates(), shipped('en')], {
        phoneNumber: EGYPT,
      }).template?.language,
    ).toBe('en');
    expect(
      selectShippingTemplate([...syncedApprovedTemplates(), shipped('ar')], {
        phoneNumber: US,
      }).template?.language,
    ).toBe('ar');
  });

  it('a forced language with no approved template uses the base language', () => {
    const selection = selectShippingTemplate(
      [...syncedApprovedTemplates(), shipped('ar'), shipped('en')],
      { phoneNumber: US, preferredLanguage: 'tr' },
    );
    expect(selection).toMatchObject({
      requestedLanguage: 'tr',
      fallbackReason: 'language_unavailable',
      template: { language: 'en' },
    });
  });

  it.each([
    ['pending at the provider', { reviewStatus: 'pending' as const }],
    ['not synced yet', { reviewStatus: null }],
    ['rejected', { reviewStatus: 'rejected' as const }],
    ['inactive', { isActive: false, isDefault: false }],
    ['not the default', { isDefault: false }],
  ])('never sends a template that is %s', (_label, overrides) => {
    const selection = selectShippingTemplate(
      [
        ...seededRegistryTemplates(),
        shipped('ar', overrides),
        shipped('en', overrides),
      ],
      { phoneNumber: EGYPT },
    );
    expect(selection).toEqual({ template: null, requestedLanguage: 'ar' });
  });

  it('never picks a confirmation template', () => {
    expect(
      selectShippingTemplate(syncedApprovedTemplates(), { phoneNumber: US })
        .template,
    ).toBeNull();
  });
});
