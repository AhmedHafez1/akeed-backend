import {
  COD_CONFIRMATION_PURPOSE,
  COD_REMINDER_PURPOSE,
  type TemplateLanguage,
  type TemplatePurpose,
} from './template-registry.types';

/**
 * The drafts migration 0064 gives staff for Urdu, Spanish and French, and
 * migration 0068 for Turkish: a standard and a short confirmation and one
 * reminder per language. They are drafts only. Staff submit each one to the
 * provider and activate it once it is approved; until then no send can read
 * them.
 *
 * The migrations repeat this text, and a spec keeps them the same.
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

/** The author recorded on a draft or a text no person wrote. */
export const STARTER_DRAFT_AUTHOR_ID = '00000000-0000-0000-0000-000000000000';

export const STARTER_TEMPLATE_DRAFTS: readonly StarterTemplateDraft[] = [
  {
    purpose: COD_CONFIRMATION_PURPOSE,
    language: 'ur',
    style: 'standard',
    languageCode: 'ur',
    body: 'السلام علیکم {{customer}}،\n{{store}} پر آپ کا آرڈر {{order}} موصول ہو گیا ہے۔ کل رقم {{total}} ہے، ادائیگی کیش آن ڈیلیوری ہوگی۔\nبراہِ کرم اپنے آرڈر کی تصدیق کریں۔',
    confirmLabel: 'آرڈر کی تصدیق کریں',
    cancelLabel: 'آرڈر منسوخ کریں',
  },
  {
    purpose: COD_CONFIRMATION_PURPOSE,
    language: 'ur',
    style: 'short',
    languageCode: 'ur',
    body: 'آپ کا آرڈر {{order}} موصول ہو گیا ہے۔ کل رقم {{total}} ہے، ادائیگی کیش آن ڈیلیوری ہوگی۔ براہِ کرم تصدیق کریں۔',
    confirmLabel: 'تصدیق کریں',
    cancelLabel: 'منسوخ کریں',
  },
  {
    purpose: COD_REMINDER_PURPOSE,
    language: 'ur',
    style: 'standard',
    languageCode: 'ur',
    body: 'السلام علیکم {{customer}}،\n{{store}} پر آپ کا آرڈر {{order}} ابھی آپ کی تصدیق کا منتظر ہے۔ کل رقم {{total}} ہے، ادائیگی کیش آن ڈیلیوری ہوگی۔\nتصدیق کر دیں تاکہ ہم آپ کا آرڈر روانہ کر سکیں۔',
    confirmLabel: 'آرڈر کی تصدیق کریں',
    cancelLabel: 'آرڈر منسوخ کریں',
  },
  {
    purpose: COD_CONFIRMATION_PURPOSE,
    language: 'es',
    style: 'standard',
    languageCode: 'es',
    body: 'Hola, {{customer}}:\nHemos recibido tu pedido {{order}} en {{store}}. El total es de {{total}} y lo pagas al recibirlo.\nPor favor, confirma tu pedido.',
    confirmLabel: 'Confirmar pedido',
    cancelLabel: 'Cancelar pedido',
  },
  {
    purpose: COD_CONFIRMATION_PURPOSE,
    language: 'es',
    style: 'short',
    languageCode: 'es',
    body: 'Hemos recibido tu pedido {{order}}. El total es de {{total}} y lo pagas al recibirlo. Por favor, confírmalo.',
    confirmLabel: 'Confirmar',
    cancelLabel: 'Cancelar',
  },
  {
    purpose: COD_REMINDER_PURPOSE,
    language: 'es',
    style: 'standard',
    languageCode: 'es',
    body: 'Hola, {{customer}}:\nTu pedido {{order}} en {{store}} sigue pendiente de confirmación. El total es de {{total}} y lo pagas al recibirlo.\nConfírmalo para que podamos enviártelo.',
    confirmLabel: 'Confirmar pedido',
    cancelLabel: 'Cancelar pedido',
  },
  {
    purpose: COD_CONFIRMATION_PURPOSE,
    language: 'fr',
    style: 'standard',
    languageCode: 'fr',
    body: 'Bonjour {{customer}},\nNous avons bien reçu votre commande {{order}} sur {{store}}. Le total est de {{total}}, à payer à la livraison.\nMerci de confirmer votre commande.',
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
  {
    purpose: COD_REMINDER_PURPOSE,
    language: 'fr',
    style: 'standard',
    languageCode: 'fr',
    body: "Bonjour {{customer}},\nVotre commande {{order}} sur {{store}} attend toujours votre confirmation. Le total est de {{total}}, à payer à la livraison.\nConfirmez-la pour que nous puissions vous l'expédier.",
    confirmLabel: 'Confirmer la commande',
    cancelLabel: 'Annuler la commande',
  },
  {
    purpose: COD_CONFIRMATION_PURPOSE,
    language: 'tr',
    style: 'standard',
    languageCode: 'tr',
    body: 'Merhaba {{customer}},\n{{store}} üzerinden verdiğiniz {{order}} numaralı siparişiniz alındı. Toplam tutar {{total}}; ödeme kapıda yapılacaktır.\nLütfen siparişinizi onaylayın.',
    confirmLabel: 'Siparişi onayla',
    cancelLabel: 'Siparişi iptal et',
  },
  {
    purpose: COD_CONFIRMATION_PURPOSE,
    language: 'tr',
    style: 'short',
    languageCode: 'tr',
    body: 'Merhaba, {{order}} numaralı siparişiniz alındı. Toplam tutar {{total}}; ödeme kapıda yapılacaktır. Lütfen onaylayın.',
    confirmLabel: 'Onayla',
    cancelLabel: 'İptal et',
  },
  {
    purpose: COD_REMINDER_PURPOSE,
    language: 'tr',
    style: 'standard',
    languageCode: 'tr',
    body: 'Merhaba {{customer}},\n{{store}} üzerinden verdiğiniz {{order}} numaralı siparişiniz hâlâ onayınızı bekliyor. Toplam tutar {{total}}; ödeme kapıda yapılacaktır.\nSiparişinizi gönderebilmemiz için lütfen onaylayın.',
    confirmLabel: 'Siparişi onayla',
    cancelLabel: 'Siparişi iptal et',
  },
];
