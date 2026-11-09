import type { UsageAlertEmail, UsageAlertLanguage } from './usage-alert-copy';
import { isEmail } from 'class-validator';

const COPY: Record<
  UsageAlertLanguage,
  {
    subject: string;
    store: string;
    order: string;
    source: string;
    time: string;
    action: string;
    open: string;
  }
> = {
  en: {
    subject: 'An order needs your attention',
    store: 'Store',
    order: 'Order',
    source: 'Order source',
    time: 'Request time',
    action:
      'The customer requested a change. Contact them before shipping, then confirm, cancel or send an updated confirmation in Akeed.',
    open: 'Review the request in Akeed',
  },
  ar: {
    subject: 'طلب محتاج تدخلك',
    store: 'المتجر',
    order: 'الطلب',
    source: 'مصدر الطلب',
    time: 'وقت طلب التعديل',
    action:
      'العميل طلب تعديل. تواصل معاه قبل الشحن، وبعدها أكّد الطلب أو الغيه أو ابعت تأكيد محدّث من أكيد.',
    open: 'راجع طلب التعديل في أكيد',
  },
  ur: {
    subject: 'ایک آرڈر کو آپ کی توجہ درکار ہے',
    store: 'اسٹور',
    order: 'آرڈر',
    source: 'آرڈر کا ذریعہ',
    time: 'درخواست کا وقت',
    action:
      'گاہک نے تبدیلی کی درخواست کی ہے۔ بھیجنے سے پہلے ان سے رابطہ کریں، پھر اکید میں آرڈر کی تصدیق یا منسوخی کریں یا تازہ تصدیق بھیجیں۔',
    open: 'اکید میں درخواست دیکھیں',
  },
  es: {
    subject: 'Un pedido necesita tu atención',
    store: 'Tienda',
    order: 'Pedido',
    source: 'Origen del pedido',
    time: 'Hora de la solicitud',
    action:
      'El cliente ha solicitado un cambio. Ponte en contacto antes del envío y después confirma, cancela o envía una confirmación actualizada en Akeed.',
    open: 'Revisar la solicitud en Akeed',
  },
  fr: {
    subject: 'Une commande nécessite votre attention',
    store: 'Boutique',
    order: 'Commande',
    source: 'Origine de la commande',
    time: 'Date de la demande',
    action:
      'Le client a demandé une modification. Contactez-le avant l’expédition, puis confirmez, annulez ou envoyez une confirmation actualisée dans Akeed.',
    open: 'Consulter la demande dans Akeed',
  },
  tr: {
    subject: 'Bir sipariş ilginizi bekliyor',
    store: 'Mağaza',
    order: 'Sipariş',
    source: 'Sipariş kaynağı',
    time: 'Talep zamanı',
    action:
      'Müşteri değişiklik istedi. Göndermeden önce müşteriyle iletişime geçin, ardından Akeed üzerinden onaylayın, iptal edin veya güncellenmiş bir onay gönderin.',
    open: 'Talebi Akeed üzerinden incele',
  },
};
const html = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export function usableNotificationEmail(
  value: string | null | undefined,
): string | null {
  const email = value?.trim() ?? '';
  return isEmail(email) &&
    !email.toLowerCase().endsWith('@akeed-shopify.internal')
    ? email
    : null;
}

/** Public navigation only; order data is fetched later through authenticated tenant APIs. */
export function changeRequestDashboardLink(input: {
  language: UsageAlertLanguage;
  verificationId: string;
  platformType: string;
  platformStoreUrl: string;
  dashboardUrl: string | null;
  shopifyApiKey?: string;
}): string | null {
  let url: URL;
  if (input.platformType === 'shopify') {
    const shop = input.platformStoreUrl
      .replace(/^https:\/\//, '')
      .replace(/\/$/, '');
    if (
      !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop) ||
      !input.shopifyApiKey
    )
      return null;
    url = new URL(
      `https://${shop}/admin/apps/${encodeURIComponent(input.shopifyApiKey)}/${input.language}/verifications`,
    );
  } else {
    try {
      url = new URL(input.dashboardUrl ?? '');
    } catch {
      return null;
    }
    if (
      url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1'].includes(url.hostname)
      )
    )
      return null;
    if (url.username || url.password) return null;
    url.pathname = `/${input.language}/verifications`;
  }
  url.search = '';
  url.hash = '';
  url.searchParams.set('open', input.verificationId);
  return url.toString();
}

export function buildChangeRequestEmail(
  language: UsageAlertLanguage,
  facts: {
    store: string;
    order: string;
    source: string;
    openedAt: string;
    timezone: string;
    link: string;
  },
): UsageAlertEmail {
  const copy = COPY[language];
  let time: string;
  try {
    time = new Intl.DateTimeFormat(language, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: facts.timezone,
    }).format(new Date(facts.openedAt));
  } catch {
    time = facts.openedAt;
  }
  const lines = [
    `${copy.store}: ${facts.store}`,
    `${copy.order}: #${facts.order.replace(/^#/, '')}`,
    `${copy.source}: ${facts.source}`,
    `${copy.time}: ${time}`,
    copy.action,
  ];
  return {
    subject: `${copy.subject} — #${facts.order.replace(/^#/, '')}`,
    text: [...lines, `${copy.open}: ${facts.link}`].join('\n\n'),
    html: `<div dir="${['ar', 'ur'].includes(language) ? 'rtl' : 'ltr'}" lang="${language}">${lines.map((line) => `<p>${html(line)}</p>`).join('')}<p><a href="${html(facts.link)}">${html(copy.open)}</a></p></div>`,
  };
}
