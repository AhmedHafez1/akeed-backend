import {
  COD_TEMPLATE_DEFAULTS,
  getArabicCodTemplateDefinition,
  getCodTemplateDefinition,
  getDefaultCodTemplatePreviews,
  getEnglishCodTemplateDefinition,
} from './cod-template-catalog';

describe('cod-template-catalog', () => {
  it('uses Friendly EN and Standard AR as defaults', () => {
    expect(COD_TEMPLATE_DEFAULTS).toEqual({ ar: 'standard', en: 'friendly' });

    const previews = getDefaultCodTemplatePreviews();
    expect(previews.en.confirmButton).toBe('Confirm Order');
    expect(previews.ar.confirmButton).toBe('تأكيد الطلب');
  });

  it('resolves english professional template with meta name override', () => {
    const template = getEnglishCodTemplateDefinition('professional');

    expect(template.metaTemplateName).toBe(
      '_akeed_cod_verification_professional',
    );
    expect(template.metaLanguageCode).toBe('en');
    expect(template.bodyParameterOrder).toEqual([
      'customer',
      'store',
      'order',
      'total',
    ]);
  });

  it('resolves arabic egyptian template with ar_EG locale', () => {
    const template = getArabicCodTemplateDefinition('egyptian');

    expect(template.metaTemplateName).toBe('akeed_cod_verification_direct_eg');
    expect(template.metaLanguageCode).toBe('ar_EG');
  });

  it('keeps short templates on two body parameters', () => {
    const shortAr = getCodTemplateDefinition({
      language: 'ar',
      selection: { ar: 'short' },
    });
    const shortEn = getCodTemplateDefinition({
      language: 'en',
      selection: { en: 'short' },
    });

    expect(shortAr.metaTemplateName).toBe('akeed_cod_verification');
    expect(shortEn.metaTemplateName).toBe('akeed_cod_verification');
    expect(shortAr.bodyParameterOrder).toEqual(['order', 'total']);
    expect(shortEn.bodyParameterOrder).toEqual(['order', 'total']);
  });
});
