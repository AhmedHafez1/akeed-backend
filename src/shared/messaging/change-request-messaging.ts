import { createHash } from 'node:crypto';
import type {
  TemplateLanguage,
  RegistryTemplate,
} from './template-registry.types';
import type { CustomerReplyIntent } from '../verification/customer-reply-intent';
import { resolveButtonPayload } from '../verification/customer-reply-intent';

export type CustomerButtonAction = CustomerReplyIntent | 'change_requested';

export const CHANGE_BUTTON_LABELS: Record<TemplateLanguage, string> = {
  ar: 'طلب تعديل',
  en: 'Request a change',
  ur: 'تبدیلی کی درخواست',
  es: 'Solicitar un cambio',
  fr: 'Demander une modification',
  tr: 'Değişiklik iste',
};

/** Fixed service copy, deliberately independent of editable thank-you messages. */
export function changeAcknowledgment(
  language: TemplateLanguage,
  style: string,
  store: string,
  order: string,
): string {
  if (language === 'ar') {
    if (/egyptian/.test(style))
      return `وصل طلب تعديل الأوردر رقم ${order} لمتجر ${store}. المتجر هيتواصل معاك.`;
    if (/gulf/.test(style))
      return `وصل طلب تعديل طلبك رقم ${order} من متجر ${store}. المتجر بيتواصل معك.`;
    return `تم استلام طلب تعديل الطلب رقم ${order} لدى متجر ${store}. سيتواصل المتجر معك.`;
  }
  const copy: Record<Exclude<TemplateLanguage, 'ar'>, string> = {
    en: `We've received your change request for order ${order} at ${store}. The store will contact you.`,
    ur: `${store} پر آرڈر ${order} میں تبدیلی کی آپ کی درخواست موصول ہو گئی ہے۔ اسٹور آپ سے رابطہ کرے گا۔`,
    es: `Hemos recibido tu solicitud de cambio para el pedido ${order} de ${store}. La tienda se pondrá en contacto contigo.`,
    fr: `Nous avons reçu votre demande de modification pour la commande ${order} chez ${store}. La boutique vous contactera.`,
    tr: `${store} mağazasındaki ${order} numaralı siparişiniz için değişiklik talebinizi aldık. Mağaza sizinle iletişime geçecek.`,
  };
  return copy[language];
}

/** Store only a digest on the dispatch; phone formatting does not change identity. */
export function customerRecipientHash(
  phone: string | null | undefined,
): string | null {
  if (!phone || !/^\+?[0-9 ()-]{6,32}$/.test(phone)) return null;
  const digits = phone?.replace(/[^0-9]/g, '');
  return digits && digits.length >= 6 && digits.length <= 15
    ? createHash('sha256').update(digits).digest('hex')
    : null;
}

export function customerButtonPayload(
  action: CustomerButtonAction,
  verificationId: string,
  cycle: number,
): string {
  return `cr1|${action}|${verificationId}|${cycle}`;
}

export function resolveCustomerActionPayload(payload: string): {
  intent: CustomerButtonAction;
  verificationId: string;
  cycle?: number;
} | null {
  if (!payload.startsWith('cr1|')) return resolveButtonPayload(payload);
  const [version, intent, verificationId, rawCycle, extra] = payload.split('|');
  const cycle = Number(rawCycle);
  if (
    version !== 'cr1' ||
    extra !== undefined ||
    !['confirmed', 'canceled', 'change_requested'].includes(intent) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      verificationId,
    ) ||
    !/^[1-9]\d*$/.test(rawCycle) ||
    !Number.isSafeInteger(cycle)
  )
    return null;
  return { intent: intent as CustomerButtonAction, verificationId, cycle };
}

/** Approval alone is insufficient: the provider must hold exactly these usable buttons. */
export function changeTemplateUsable(
  template: RegistryTemplate,
  requireSharedApproval = true,
): boolean {
  const snapshot = template.components;
  return Boolean(
    template.changeRequestOfKey &&
    template.isActive &&
    (!requireSharedApproval ||
      (template.reviewStatus === 'approved' &&
        template.category === 'utility' &&
        template.lastSyncedAt)) &&
    snapshot &&
    !('unknown' in snapshot) &&
    snapshot.buttons.length === 3 &&
    snapshot.buttons.every(
      (button) => button.kind === 'quick_reply' && button.text.length <= 25,
    ) &&
    snapshot.buttons[0].text === template.preview.confirmButton &&
    snapshot.buttons[1].text === template.preview.cancelButton &&
    snapshot.buttons[2].text === CHANGE_BUTTON_LABELS[template.language],
  );
}
