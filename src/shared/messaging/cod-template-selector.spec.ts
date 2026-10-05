import {
  resolveTemplateSendPurpose,
  selectCodTemplate,
  toSentTemplateIdentity,
} from './cod-template-selector';

const ARABIC_PHONE = '+201001112223';
const NON_ARABIC_PHONE = '+14155550101';

describe('selectCodTemplate', () => {
  const variants = [
    {
      language: 'ar',
      variant: 'standard',
      templateName: 'akeed_cod_verification_friendly',
      languageCode: 'ar',
      bodyVariableMode: 'named',
      bodyParameterOrder: ['customer', 'store', 'order', 'total'],
    },
    {
      language: 'ar',
      variant: 'egyptian',
      templateName: 'akeed_cod_verification_direct_eg',
      languageCode: 'ar_EG',
      bodyVariableMode: 'named',
      bodyParameterOrder: ['customer', 'order', 'store', 'total'],
    },
    {
      language: 'ar',
      variant: 'gulf',
      templateName: 'akeed_cod_verification_direct_gulf',
      languageCode: 'ar',
      bodyVariableMode: 'named',
      bodyParameterOrder: ['customer', 'order', 'store', 'total'],
    },
    {
      language: 'ar',
      variant: 'short',
      templateName: 'akeed_cod_verification',
      languageCode: 'ar',
      bodyVariableMode: 'positional',
      bodyParameterOrder: ['order', 'total'],
    },
    {
      language: 'en',
      variant: 'friendly',
      templateName: 'akeed_cod_verification_friendly',
      languageCode: 'en',
      bodyVariableMode: 'named',
      bodyParameterOrder: ['customer', 'store', 'order', 'total'],
    },
    {
      language: 'en',
      variant: 'professional',
      templateName: '_akeed_cod_verification_professional',
      languageCode: 'en',
      bodyVariableMode: 'named',
      bodyParameterOrder: ['customer', 'store', 'order', 'total'],
    },
    {
      language: 'en',
      variant: 'direct',
      templateName: 'akeed_cod_verification_direct_',
      languageCode: 'en',
      bodyVariableMode: 'named',
      bodyParameterOrder: ['customer', 'order', 'store', 'total'],
    },
    {
      language: 'en',
      variant: 'short',
      templateName: 'akeed_cod_verification',
      languageCode: 'en',
      bodyVariableMode: 'positional',
      bodyParameterOrder: ['order', 'total'],
    },
  ] as const;

  it.each(variants)(
    'selects $language.$variant with the name, code and fill order it is sent with',
    (expected) => {
      const selected = selectCodTemplate({
        preferredLanguage: expected.language,
        phoneNumber:
          expected.language === 'ar' ? NON_ARABIC_PHONE : ARABIC_PHONE,
        arVariant: expected.language === 'ar' ? expected.variant : 'standard',
        enVariant: expected.language === 'en' ? expected.variant : 'friendly',
      });

      expect(selected).toEqual({
        variantKey: `${expected.language}.${expected.variant}`,
        language: expected.language,
        templateName: expected.templateName,
        languageCode: expected.languageCode,
        bodyVariableMode: expected.bodyVariableMode,
        bodyParameterOrder: expected.bodyParameterOrder,
      });
    },
  );

  const store = { arVariant: 'gulf', enVariant: 'direct' };

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
        selectCodTemplate({ ...store, preferredLanguage, phoneNumber })
          .variantKey,
      ).toBe(variantKey);
    },
  );

  it.each([
    ['an unknown Arabic variant', 'ar', 'retired_variant', 'ar.standard'],
    ['an English variant stored as Arabic', 'ar', 'friendly', 'ar.standard'],
    ['a missing Arabic variant', 'ar', null, 'ar.standard'],
    ['an unknown English variant', 'en', 'retired_variant', 'en.friendly'],
    ['an Arabic variant stored as English', 'en', 'egyptian', 'en.friendly'],
    ['a missing English variant', 'en', undefined, 'en.friendly'],
  ])(
    'falls back to the language default for %s',
    (_label, language, stored, variantKey) => {
      expect(
        selectCodTemplate({
          preferredLanguage: language,
          phoneNumber: ARABIC_PHONE,
          arVariant: stored,
          enVariant: stored,
        }).variantKey,
      ).toBe(variantKey);
    },
  );

  it.each([null, undefined])(
    'selects without throwing when the number is %s',
    (phoneNumber) => {
      expect(
        selectCodTemplate({ preferredLanguage: 'auto', phoneNumber })
          .variantKey,
      ).toBe('en.friendly');
    },
  );

  it('reduces a selection to the identity that is recorded', () => {
    const selected = selectCodTemplate({
      preferredLanguage: 'ar',
      phoneNumber: ARABIC_PHONE,
      arVariant: 'egyptian',
    });

    expect(toSentTemplateIdentity(selected)).toEqual({
      variantKey: 'ar.egyptian',
      language: 'ar',
      templateName: 'akeed_cod_verification_direct_eg',
      languageCode: 'ar_EG',
    });
  });
});

describe('resolveTemplateSendPurpose', () => {
  it.each([
    ['initial', false, 'initial'],
    ['follow_up', false, 'reminder'],
    ['initial', true, 'test'],
    ['follow_up', true, 'test'],
  ] as const)(
    'a %s dispatch for a test order %s is %s',
    (kind, isTestOrder, purpose) => {
      expect(resolveTemplateSendPurpose({ kind, isTestOrder })).toBe(purpose);
    },
  );
});
