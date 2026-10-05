import { toSentTemplateIdentity } from './cod-template-selector';
import { seededRegistryTemplates } from './testing/seeded-template-registry';
import {
  findDefaultTemplate,
  findSelectableByStyle,
  resolveTemplate,
  selectableTemplates,
  selectTemplateForSend,
  storedTemplateKey,
} from './template-selector';
import type { RegistryTemplate } from './template-registry.types';

/* eslint-disable @typescript-eslint/no-unsafe-assignment */

const ARABIC_PHONE = '+201001112223';
const NON_ARABIC_PHONE = '+14155550101';

const registry = seededRegistryTemplates();

function withRow(
  key: string,
  change: Partial<RegistryTemplate>,
): RegistryTemplate[] {
  return registry.map((template) =>
    template.key === key ? { ...template, ...change } : template,
  );
}

describe('selectTemplateForSend', () => {
  const variants = [
    {
      language: 'ar',
      style: 'standard',
      templateName: 'akeed_cod_verification_friendly',
      languageCode: 'ar',
      parameterFormat: 'named',
      order: ['customer', 'store', 'order', 'total'],
    },
    {
      language: 'ar',
      style: 'egyptian',
      templateName: 'akeed_cod_verification_direct_eg',
      languageCode: 'ar_EG',
      parameterFormat: 'named',
      order: ['customer', 'order', 'store', 'total'],
    },
    {
      language: 'ar',
      style: 'gulf',
      templateName: 'akeed_cod_verification_direct_gulf',
      languageCode: 'ar',
      parameterFormat: 'named',
      order: ['customer', 'order', 'store', 'total'],
    },
    {
      language: 'ar',
      style: 'short',
      templateName: 'akeed_cod_verification',
      languageCode: 'ar',
      parameterFormat: 'positional',
      order: ['order', 'total'],
    },
    {
      language: 'en',
      style: 'friendly',
      templateName: 'akeed_cod_verification_friendly',
      languageCode: 'en',
      parameterFormat: 'named',
      order: ['customer', 'store', 'order', 'total'],
    },
    {
      language: 'en',
      style: 'professional',
      templateName: '_akeed_cod_verification_professional',
      languageCode: 'en',
      parameterFormat: 'named',
      order: ['customer', 'store', 'order', 'total'],
    },
    {
      language: 'en',
      style: 'direct',
      templateName: 'akeed_cod_verification_direct_',
      languageCode: 'en',
      parameterFormat: 'named',
      order: ['customer', 'order', 'store', 'total'],
    },
    {
      language: 'en',
      style: 'short',
      templateName: 'akeed_cod_verification',
      languageCode: 'en',
      parameterFormat: 'positional',
      order: ['order', 'total'],
    },
  ] as const;

  it.each(variants)(
    'selects $language.$style by its key with the name, code and fill order it is sent with',
    (expected) => {
      const key = `cod_confirm.${expected.language}.${expected.style}`;
      const selection = selectTemplateForSend(registry, {
        preferredLanguage: expected.language,
        phoneNumber:
          expected.language === 'ar' ? NON_ARABIC_PHONE : ARABIC_PHONE,
        arKey: expected.language === 'ar' ? key : 'cod_confirm.ar.standard',
        enKey: expected.language === 'en' ? key : 'cod_confirm.en.friendly',
      });

      expect(selection).toEqual({
        template: {
          variantKey: `${expected.language}.${expected.style}`,
          language: expected.language,
          templateName: expected.templateName,
          languageCode: expected.languageCode,
          parameterFormat: expected.parameterFormat,
          variables: expected.order.map((variableKey) =>
            expected.parameterFormat === 'named'
              ? { key: variableKey, name: variableKey }
              : { key: variableKey },
          ),
        },
        storedKey: key,
        fallbackReason: undefined,
      });
    },
  );

  it.each(variants)(
    'selects $language.$style from the old variant column when no key is stored',
    (expected) => {
      const selection = selectTemplateForSend(registry, {
        preferredLanguage: expected.language,
        phoneNumber: ARABIC_PHONE,
        arKey: null,
        enKey: undefined,
        arLegacyVariant: expected.style,
        enLegacyVariant: expected.style,
      });

      expect(selection.template?.variantKey).toBe(
        `${expected.language}.${expected.style}`,
      );
      expect(selection).not.toHaveProperty('reason');
    },
  );

  it('prefers the stored key over the old variant column', () => {
    const selection = selectTemplateForSend(registry, {
      preferredLanguage: 'ar',
      phoneNumber: ARABIC_PHONE,
      arKey: 'cod_confirm.ar.gulf',
      arLegacyVariant: 'egyptian',
    });

    expect(selection.template?.variantKey).toBe('ar.gulf');
  });

  const store = {
    arKey: 'cod_confirm.ar.gulf',
    enKey: 'cod_confirm.en.direct',
  };

  it.each([
    ['auto', ARABIC_PHONE, 'ar.gulf'],
    ['auto', NON_ARABIC_PHONE, 'en.direct'],
    ['auto', '0501234567', 'en.direct'],
    [null, ARABIC_PHONE, 'ar.gulf'],
    [undefined, NON_ARABIC_PHONE, 'en.direct'],
    ['ar', NON_ARABIC_PHONE, 'ar.gulf'],
    ['ar', ARABIC_PHONE, 'ar.gulf'],
    ['en', ARABIC_PHONE, 'en.direct'],
    ['en', NON_ARABIC_PHONE, 'en.direct'],
  ])(
    'resolves a %s preference and the number %s to %s',
    (preferredLanguage, phoneNumber, variantKey) => {
      expect(
        selectTemplateForSend(registry, {
          ...store,
          preferredLanguage,
          phoneNumber,
        }).template?.variantKey,
      ).toBe(variantKey);
    },
  );

  it.each([
    [
      'an unknown key',
      'ar',
      'cod_confirm.ar.retired',
      'ar.standard',
      'key_unknown',
    ],
    [
      'an English key stored as Arabic',
      'ar',
      'cod_confirm.en.friendly',
      'ar.standard',
      'wrong_language',
    ],
    ['a missing Arabic key', 'ar', null, 'ar.standard', 'key_missing'],
    [
      'an unknown English key',
      'en',
      'cod_confirm.en.retired',
      'en.friendly',
      'key_unknown',
    ],
    [
      'an Arabic key stored as English',
      'en',
      'cod_confirm.ar.egyptian',
      'en.friendly',
      'wrong_language',
    ],
    ['a missing English key', 'en', undefined, 'en.friendly', 'key_missing'],
  ] as const)(
    'falls back to the language default for %s and says why',
    (_label, language, stored, variantKey, reason) => {
      const selection = selectTemplateForSend(registry, {
        preferredLanguage: language,
        phoneNumber: ARABIC_PHONE,
        arKey: stored,
        enKey: stored,
      });

      expect(selection.template?.variantKey).toBe(variantKey);
      expect(selection).toMatchObject({
        storedKey: stored ?? null,
        fallbackReason: reason,
      });
    },
  );

  it.each([
    ['an unknown old variant', 'ar', 'retired_variant', 'ar.standard'],
    ['an English variant stored as Arabic', 'ar', 'friendly', 'ar.standard'],
    ['an Arabic variant stored as English', 'en', 'egyptian', 'en.friendly'],
  ] as const)(
    'falls back to the language default for %s',
    (_label, language, stored, variantKey) => {
      const selection = selectTemplateForSend(registry, {
        preferredLanguage: language,
        phoneNumber: ARABIC_PHONE,
        arLegacyVariant: stored,
        enLegacyVariant: stored,
      });

      expect(selection.template?.variantKey).toBe(variantKey);
      expect(selection).toMatchObject({ fallbackReason: 'key_unknown' });
    },
  );

  it('does not send an inactive template: the default stands in', () => {
    const selection = selectTemplateForSend(
      withRow('cod_confirm.ar.gulf', { isActive: false }),
      {
        preferredLanguage: 'ar',
        phoneNumber: ARABIC_PHONE,
        arKey: 'cod_confirm.ar.gulf',
      },
    );

    expect(selection.template?.variantKey).toBe('ar.standard');
    expect(selection).toMatchObject({
      storedKey: 'cod_confirm.ar.gulf',
      fallbackReason: 'key_inactive',
    });
  });

  it.each([
    ['is inactive', { isActive: false, isDefault: false }],
    ['is no longer the default', { isDefault: false }],
  ])(
    'selects nothing when the stored key is unusable and the default %s',
    (_label, change) => {
      const selection = selectTemplateForSend(
        withRow('cod_confirm.ar.standard', change),
        {
          preferredLanguage: 'ar',
          phoneNumber: ARABIC_PHONE,
          arKey: 'cod_confirm.ar.retired',
        },
      );

      expect(selection).toEqual({
        template: null,
        language: 'ar',
        storedKey: 'cod_confirm.ar.retired',
        reason: 'default_unavailable',
      });
    },
  );

  it('still sends a valid stored choice when the language has no default', () => {
    const selection = selectTemplateForSend(
      withRow('cod_confirm.ar.standard', { isDefault: false }),
      {
        preferredLanguage: 'ar',
        phoneNumber: ARABIC_PHONE,
        arKey: 'cod_confirm.ar.egyptian',
      },
    );

    expect(selection.template?.variantKey).toBe('ar.egyptian');
  });

  it.each([null, undefined])(
    'selects without throwing when the number is %s',
    (phoneNumber) => {
      expect(
        selectTemplateForSend(registry, {
          preferredLanguage: 'auto',
          phoneNumber,
        }).template?.variantKey,
      ).toBe('en.friendly');
    },
  );

  it('reduces a selection to the identity that is recorded', () => {
    const selection = selectTemplateForSend(registry, {
      preferredLanguage: 'ar',
      phoneNumber: ARABIC_PHONE,
      arKey: 'cod_confirm.ar.egyptian',
    });
    if (!selection.template) throw new Error('expected a template');

    expect(toSentTemplateIdentity(selection.template)).toEqual({
      variantKey: 'ar.egyptian',
      language: 'ar',
      templateName: 'akeed_cod_verification_direct_eg',
      languageCode: 'ar_EG',
    });
  });
});

describe('storedTemplateKey', () => {
  it.each([
    [
      { key: 'cod_confirm.ar.gulf', legacyVariant: 'short' },
      'cod_confirm.ar.gulf',
    ],
    [{ key: null, legacyVariant: 'short' }, 'cod_confirm.ar.short'],
    [{ key: undefined, legacyVariant: null }, null],
    [{ key: '', legacyVariant: '' }, null],
  ])('reads %j as %s', (stored, expected) => {
    expect(storedTemplateKey({ language: 'ar', ...stored })).toBe(expected);
  });
});

describe('selectable templates', () => {
  it('lists the active templates of a language in registry order', () => {
    expect(
      selectableTemplates(registry, 'ar').map(({ style }) => style),
    ).toEqual(['standard', 'egyptian', 'gulf', 'short']);
    expect(
      selectableTemplates(registry, 'en').map(({ style }) => style),
    ).toEqual(['friendly', 'professional', 'direct', 'short']);
  });

  it('leaves an inactive template out', () => {
    const templates = withRow('cod_confirm.en.direct', { isActive: false });

    expect(
      selectableTemplates(templates, 'en').map(({ style }) => style),
    ).toEqual(['friendly', 'professional', 'short']);
    expect(findSelectableByStyle(templates, 'en', 'direct')).toBeUndefined();
  });

  it('finds a style only in its own language', () => {
    expect(findSelectableByStyle(registry, 'ar', 'gulf')?.key).toBe(
      'cod_confirm.ar.gulf',
    );
    expect(findSelectableByStyle(registry, 'en', 'gulf')).toBeUndefined();
    expect(findSelectableByStyle(registry, 'ar', 'friendly')).toBeUndefined();
    expect(findSelectableByStyle(registry, 'ar', 'short')?.key).toBe(
      'cod_confirm.ar.short',
    );
    expect(findSelectableByStyle(registry, 'en', 'short')?.key).toBe(
      'cod_confirm.en.short',
    );
  });

  it('has one default per language', () => {
    expect(findDefaultTemplate(registry, 'ar')?.key).toBe(
      'cod_confirm.ar.standard',
    );
    expect(findDefaultTemplate(registry, 'en')?.key).toBe(
      'cod_confirm.en.friendly',
    );
  });
});

describe('resolveTemplate', () => {
  it('returns the stored template without a fallback reason', () => {
    expect(
      resolveTemplate(registry, {
        language: 'en',
        storedKey: 'cod_confirm.en.professional',
      }),
    ).toEqual({
      template: expect.objectContaining({ key: 'cod_confirm.en.professional' }),
    });
  });
});
