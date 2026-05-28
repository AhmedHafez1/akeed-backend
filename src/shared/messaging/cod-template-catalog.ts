export type CodTemplateLanguage = 'ar' | 'en';

export type ArabicCodTemplateVariantId =
  | 'standard'
  | 'egyptian'
  | 'gulf'
  | 'short';

export type EnglishCodTemplateVariantId =
  | 'friendly'
  | 'professional'
  | 'direct'
  | 'short';

export type CodTemplateVariantId =
  | ArabicCodTemplateVariantId
  | EnglishCodTemplateVariantId;

export type CodTemplateVariableKey = 'customer' | 'store' | 'order' | 'total';

export interface CodTemplatePreview {
  greeting: string;
  body: string;
  totalLabel: string;
  ending: string;
  confirmButton: string;
  cancelButton: string;
}

export interface CodTemplateDefinition {
  language: CodTemplateLanguage;
  variant: CodTemplateVariantId;
  metaTemplateName: string;
  metaLanguageCode: string;
  bodyParameterOrder: CodTemplateVariableKey[];
  preview: CodTemplatePreview;
}

export interface CodTemplateSelection {
  ar: ArabicCodTemplateVariantId;
  en: EnglishCodTemplateVariantId;
}

export const COD_TEMPLATE_DEFAULTS: CodTemplateSelection = {
  ar: 'standard',
  en: 'friendly',
};

const ARABIC_COD_TEMPLATE_CATALOG: Record<
  ArabicCodTemplateVariantId,
  CodTemplateDefinition
> = {
  standard: {
    language: 'ar',
    variant: 'standard',
    metaTemplateName: 'akeed_cod_verification_friendly',
    metaLanguageCode: 'ar',
    bodyParameterOrder: ['customer', 'store', 'order', 'total'],
    preview: {
      greeting: 'أهلًا بك {{customer}} 👋',
      body: 'شكرًا لتسوّقك من {{store}}. طلبك رقم #{{order}} بقيمة {{total}} جاهز تقريبًا للشحن!',
      totalLabel: 'إجمالي الطلب: {{total}}',
      ending: 'يرجى تأكيد الطلب لنتمكن من إرساله إليك بأسرع وقت.',
      confirmButton: 'تأكيد الطلب',
      cancelButton: 'إلغاء الطلب',
    },
  },
  egyptian: {
    language: 'ar',
    variant: 'egyptian',
    metaTemplateName: 'akeed_cod_verification_direct_eg',
    metaLanguageCode: 'ar_EG',
    bodyParameterOrder: ['customer', 'order', 'store', 'total'],
    preview: {
      greeting: 'أهلًا {{customer}}،',
      body: 'طلبك رقم #{{order}} من {{store}} مستني تأكيدك.',
      totalLabel: 'إجمالي الطلب: {{total}}',
      ending: 'ياريت تأكّد الطلب بقيمة {{total}} دلوقتي عشان نشحنهولك فورًا.',
      confirmButton: 'تأكيد وشحن',
      cancelButton: 'إلغاء الطلب',
    },
  },
  gulf: {
    language: 'ar',
    variant: 'gulf',
    metaTemplateName: 'akeed_cod_verification_direct_gulf',
    metaLanguageCode: 'ar',
    bodyParameterOrder: ['customer', 'order', 'store', 'total'],
    preview: {
      greeting: 'أهلًا {{customer}}،',
      body: 'طلبك رقم #{{order}} من {{store}} بانتظار تأكيدك.',
      totalLabel: 'إجمالي الطلب: {{total}}',
      ending:
        'ياليت تأكد الدفع عند الاستلام بقيمة {{total}} الحين عشان نطلعه للشحن فورًا وما يتأخر عليك.',
      confirmButton: 'اشحن طلبي',
      cancelButton: 'إلغاء',
    },
  },
  short: {
    language: 'ar',
    variant: 'short',
    metaTemplateName: 'akeed_cod_verification',
    metaLanguageCode: 'ar',
    bodyParameterOrder: ['order', 'total'],
    preview: {
      greeting: 'السلام عليكم',
      body: 'تم استلام طلبك رقم #{order_number} والدفع عند الاستلام',
      totalLabel: 'إجمالي السعر: {total}',
      ending: 'من فضلك أكد الطلب.',
      confirmButton: 'تأكيد',
      cancelButton: 'إلغاء',
    },
  },
};

const ENGLISH_COD_TEMPLATE_CATALOG: Record<
  EnglishCodTemplateVariantId,
  CodTemplateDefinition
> = {
  friendly: {
    language: 'en',
    variant: 'friendly',
    metaTemplateName: 'akeed_cod_verification_friendly',
    metaLanguageCode: 'en',
    bodyParameterOrder: ['customer', 'store', 'order', 'total'],
    preview: {
      greeting: 'Hi {{customer}}! 👋',
      body: 'Thank you for shopping with {{store}}.',
      totalLabel: 'Your order #{{order}} for {{total}} is ready to go!',
      ending:
        'Please tap the button below to confirm your order so we can ship it immediately.',
      confirmButton: 'Confirm Order',
      cancelButton: 'Cancel Order',
    },
  },
  professional: {
    language: 'en',
    variant: 'professional',
    metaTemplateName: '_akeed_cod_verification_professional',
    metaLanguageCode: 'en',
    bodyParameterOrder: ['customer', 'store', 'order', 'total'],
    preview: {
      greeting: 'Hello {{customer}},',
      body: 'Thank you for choosing {{store}}.',
      totalLabel:
        'We have received your Cash on Delivery order #{{order}} for {{total}}.',
      ending: 'Once confirmed, we will ship your order.',
      confirmButton: 'Confirm & Ship',
      cancelButton: 'Cancel Order',
    },
  },
  direct: {
    language: 'en',
    variant: 'direct',
    metaTemplateName: 'akeed_cod_verification_direct',
    metaLanguageCode: 'en',
    bodyParameterOrder: ['customer', 'order', 'store', 'total'],
    preview: {
      greeting: 'Hi {{customer}},',
      body: 'We are preparing your order #{{order}} at {{store}}.',
      totalLabel: 'Please confirm your COD total of {{total}} right now',
      ending: 'so we ship your order immediately.',
      confirmButton: 'Ship My Order',
      cancelButton: 'Cancel',
    },
  },
  short: {
    language: 'en',
    variant: 'short',
    metaTemplateName: 'akeed_cod_verification',
    metaLanguageCode: 'en',
    bodyParameterOrder: ['order', 'total'],
    preview: {
      greeting: 'Hello',
      body: 'We have received your order #{order_number} with Cash on Delivery.',
      totalLabel: 'Total Price: {total}',
      ending: 'Please confirm your order.',
      confirmButton: 'Confirm',
      cancelButton: 'Cancel',
    },
  },
};

export function getArabicCodTemplateDefinition(
  variant: ArabicCodTemplateVariantId = COD_TEMPLATE_DEFAULTS.ar,
): CodTemplateDefinition {
  return ARABIC_COD_TEMPLATE_CATALOG[variant];
}

export function getEnglishCodTemplateDefinition(
  variant: EnglishCodTemplateVariantId = COD_TEMPLATE_DEFAULTS.en,
): CodTemplateDefinition {
  return ENGLISH_COD_TEMPLATE_CATALOG[variant];
}

export function getCodTemplateDefinition(params: {
  language: CodTemplateLanguage;
  selection?: Partial<CodTemplateSelection>;
}): CodTemplateDefinition {
  if (params.language === 'ar') {
    return getArabicCodTemplateDefinition(params.selection?.ar);
  }

  return getEnglishCodTemplateDefinition(params.selection?.en);
}

export function getDefaultCodTemplatePreviews(): Record<
  CodTemplateLanguage,
  CodTemplatePreview
> {
  return {
    ar: getArabicCodTemplateDefinition(COD_TEMPLATE_DEFAULTS.ar).preview,
    en: getEnglishCodTemplateDefinition(COD_TEMPLATE_DEFAULTS.en).preview,
  };
}
