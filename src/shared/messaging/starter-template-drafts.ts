import {
  COD_CONFIRMATION_PURPOSE,
  type TemplateLanguage,
  type TemplatePurpose,
} from './template-registry.types';

/**
 * The drafts migration 0064 gives staff for Urdu, Spanish and French: a
 * standard and a short confirmation per language. They are drafts only. Staff
 * review the wording, submit each one to the provider and activate it once it
 * is approved; until then no send can read them.
 *
 * The migration repeats this text, and a spec keeps the two the same.
 */
export interface StarterTemplateDraft {
  purpose: TemplatePurpose;
  language: TemplateLanguage;
  style: string;
  languageCode: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
}

/** The author recorded on a draft no person wrote. */
export const STARTER_DRAFT_AUTHOR_ID = '00000000-0000-0000-0000-000000000000';

export const STARTER_TEMPLATE_DRAFTS: readonly StarterTemplateDraft[] = [
  {
    purpose: COD_CONFIRMATION_PURPOSE,
    language: 'ur',
    style: 'standard',
    languageCode: 'ur',
    body: 'السلام علیکم {{customer}}،\n{{store}} سے آپ کا آرڈر {{order}} موصول ہو گیا ہے۔ کل رقم {{total}} ہے اور ادائیگی ڈیلیوری پر ہوگی۔\nبراہِ کرم اپنے آرڈر کی تصدیق کریں۔',
    confirmLabel: 'آرڈر کی تصدیق کریں',
    cancelLabel: 'آرڈر منسوخ کریں',
  },
  {
    purpose: COD_CONFIRMATION_PURPOSE,
    language: 'ur',
    style: 'short',
    languageCode: 'ur',
    body: 'آپ کا آرڈر {{order}} موصول ہو گیا ہے۔ کل رقم {{total}} ہے اور ادائیگی ڈیلیوری پر ہوگی۔ براہِ کرم تصدیق کریں۔',
    confirmLabel: 'تصدیق کریں',
    cancelLabel: 'منسوخ کریں',
  },
  {
    purpose: COD_CONFIRMATION_PURPOSE,
    language: 'es',
    style: 'standard',
    languageCode: 'es',
    body: 'Hola {{customer}}:\nHemos recibido tu pedido {{order}} en {{store}}. El total es {{total}} y se paga contra entrega.\nPor favor, confirma tu pedido.',
    confirmLabel: 'Confirmar pedido',
    cancelLabel: 'Cancelar pedido',
  },
  {
    purpose: COD_CONFIRMATION_PURPOSE,
    language: 'es',
    style: 'short',
    languageCode: 'es',
    body: 'Hemos recibido tu pedido {{order}}. El total es {{total}} y se paga contra entrega. Por favor, confírmalo.',
    confirmLabel: 'Confirmar',
    cancelLabel: 'Cancelar',
  },
  {
    purpose: COD_CONFIRMATION_PURPOSE,
    language: 'fr',
    style: 'standard',
    languageCode: 'fr',
    body: 'Bonjour {{customer}},\nNous avons bien reçu votre commande {{order}} chez {{store}}. Le total est de {{total}}, à payer à la livraison.\nMerci de confirmer votre commande.',
    confirmLabel: 'Confirmer la commande',
    cancelLabel: 'Annuler la commande',
  },
  {
    purpose: COD_CONFIRMATION_PURPOSE,
    language: 'fr',
    style: 'short',
    languageCode: 'fr',
    body: 'Nous avons bien reçu votre commande {{order}}. Le total est de {{total}}, à payer à la livraison. Merci de la confirmer.',
    confirmLabel: 'Confirmer',
    cancelLabel: 'Annuler',
  },
];
