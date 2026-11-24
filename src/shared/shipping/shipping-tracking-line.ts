import type { TemplateLanguage } from '../messaging/template-registry.types';
import type { ShippingTracking } from './shipping-notification.types';

/**
 * The `{{tracking}}` line of the Shipped message. The provider refuses an
 * empty parameter, so an order without tracking gets a fixed sentence instead.
 * The provider also refuses line breaks and long runs of spaces in a
 * parameter, so the values are collapsed onto one line.
 */
const TRACKING_PREFIX: Record<TemplateLanguage, string> = {
  ar: 'للتتبع:',
  en: 'Tracking:',
  ur: 'ٹریکنگ:',
  es: 'Seguimiento:',
  fr: 'Suivi :',
  tr: 'Kargo takibi:',
};

const NO_TRACKING_LINE: Record<TemplateLanguage, string> = {
  ar: 'الدفع نقدًا عند الاستلام.',
  en: 'Payment is cash on delivery.',
  ur: 'ادائیگی ڈیلیوری پر نقد ہوگی۔',
  es: 'El pago es contra reembolso.',
  fr: 'Le paiement se fait à la livraison.',
  tr: 'Ödeme kapıda nakit yapılacaktır.',
};

function oneLine(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

export function shippingTrackingLine(
  language: TemplateLanguage,
  tracking: ShippingTracking | null | undefined,
): string {
  const parts = [oneLine(tracking?.number), oneLine(tracking?.url)].filter(
    (part) => part.length > 0,
  );
  if (!parts.length) return NO_TRACKING_LINE[language];
  return `${TRACKING_PREFIX[language]} ${parts.join(' – ')}`;
}
