import {
  isInterfaceLocale,
  type InterfaceLocale,
} from '../i18n/interface-locales';
import {
  isBillingPlanId,
  isOneTimeBillingPlan,
  resolveIncludedVerificationsLimit,
  resolveOwnNumberIncludedVerifications,
} from '../billing/billing-plan';
import { PREPAID_CREDIT_PLATFORMS } from '../billing/credit-eligibility';
import {
  CREDITS_PER_AKEED_MESSAGE,
  CREDITS_PER_OWN_NUMBER_MESSAGE,
  displayedUnitPriceMinor,
} from '../billing/merchant-credits';
import type { TipsValidationIssue } from './tips-campaign.types';

export interface AnnouncementTranslation {
  locale: InterfaceLocale;
  subject: string;
  body: string;
}
export interface AnnouncementEmail {
  translations: AnnouncementTranslation[];
}
export const ANNOUNCEMENT_PLACEHOLDERS = [
  'storeName',
  'planLine',
  'dashboardLink',
  'guideLink',
] as const;
export type AnnouncementValues = Record<
  (typeof ANNOUNCEMENT_PLACEHOLDERS)[number],
  string | null
>;
export const ANNOUNCEMENT_REPLAY_MS = 24 * 3_600_000 - 60_000;
export const ANNOUNCEMENT_MAX_ATTEMPTS = 5;

function hasControls(text: string, allowNewlines: boolean): boolean {
  return [...text].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return (
      code === 127 ||
      (code < 32 && !(allowNewlines && (code === 10 || code === 13)))
    );
  });
}

export function announcementIssues(
  value: unknown,
  review = false,
): TipsValidationIssue[] {
  if (value === null || value === undefined) return [];
  const issue = (code: string, locale?: string): TipsValidationIssue => ({
    field: 'email',
    code,
    ...(locale ? { locale } : {}),
  });
  if (
    typeof value !== 'object' ||
    !('translations' in value) ||
    !Array.isArray(value.translations) ||
    value.translations.length > 6
  )
    return [issue('invalid_email')];
  const issues: TipsValidationIssue[] = [];
  const locales = new Set<string>();
  for (const item of value.translations as unknown[]) {
    if (
      !item ||
      typeof item !== 'object' ||
      !('locale' in item) ||
      !isInterfaceLocale(item.locale)
    ) {
      issues.push(issue('invalid_locale'));
      continue;
    }
    const locale = item.locale;
    if (locales.has(locale)) issues.push(issue('duplicate_locale', locale));
    locales.add(locale);
    if (
      !('subject' in item) ||
      typeof item.subject !== 'string' ||
      !item.subject.trim() ||
      item.subject.length > 200 ||
      hasControls(item.subject, false) ||
      /[{}]/.test(item.subject)
    )
      issues.push(issue('invalid_subject', locale));
    if (
      !('body' in item) ||
      typeof item.body !== 'string' ||
      !item.body.trim() ||
      item.body.length > 12000 ||
      hasControls(item.body, true)
    ) {
      issues.push(issue('invalid_body', locale));
      continue;
    }
    if (review) {
      const stripped = item.body.replace(
        /\{([a-zA-Z]+)\}/g,
        (_match, key: string) => {
          if (!(ANNOUNCEMENT_PLACEHOLDERS as readonly string[]).includes(key))
            issues.push(issue('unknown_placeholder', locale));
          return '';
        },
      );
      if (/[{}]/.test(stripped))
        issues.push(issue('invalid_placeholder', locale));
    }
  }
  if (!locales.has('en')) issues.push(issue('english_required', 'en'));
  return issues;
}

const planCopy: Record<
  InterfaceLocale,
  {
    pool: (own: string, shared: string, period: string) => string;
    once: string;
    cycle: string;
    prepaid: (own: string, shared: string, price: string) => string;
    unsubscribe: string;
  }
> = {
  en: {
    pool: (a, b, p) =>
      `Your plan includes ${a} messages from your own number ${p}, on top of ${b} from Akeed's number, at the same plan price.`,
    once: 'one-time',
    cycle: 'per 30-day billing period',
    prepaid: (a, b, p) =>
      `A message from your number costs ${a} credit (${p} EGP per credit), instead of ${b} credits from Akeed's number.`,
    unsubscribe: 'Unsubscribe from announcements',
  },
  ar: {
    pool: (a, b, p) =>
      `تشمل خطتك ${a} رسالة من رقمك ${p}، إضافةً إلى ${b} رسالة من رقم أكيد، وبسعر الخطة نفسه.`,
    once: 'لمرة واحدة',
    cycle: 'لكل فترة فوترة مدتها 30 يومًا',
    prepaid: (a, b, p) =>
      `تكلف الرسالة من رقمك ${a} رصيد (${p} جنيه لكل رصيد)، بدل ${b} رصيد من رقم أكيد.`,
    unsubscribe: 'إلغاء الاشتراك في الإعلانات',
  },
  ur: {
    pool: (a, b, p) =>
      `اسی پلان کی قیمت پر آپ کے نمبر سے ${a} پیغامات ${p} شامل ہیں، Akeed کے نمبر سے ${b} پیغامات کے علاوہ۔`,
    once: 'صرف ایک بار',
    cycle: 'ہر 30 دن کی بلنگ مدت میں',
    prepaid: (a, b, p) =>
      `آپ کے نمبر سے ایک پیغام کی قیمت ${a} کریڈٹ (${p} EGP فی کریڈٹ) ہے، جبکہ Akeed کے نمبر سے ${b} کریڈٹس ہیں۔`,
    unsubscribe: 'اعلانات کی ای میلز بند کریں',
  },
  es: {
    pool: (a, b, p) =>
      `Tu plan incluye ${a} mensajes desde tu número ${p}, además de ${b} desde el número de Akeed, al mismo precio del plan.`,
    once: 'por única vez',
    cycle: 'por período de facturación de 30 días',
    prepaid: (a, b, p) =>
      `Un mensaje desde tu número cuesta ${a} crédito (${p} EGP por crédito), en lugar de ${b} créditos desde el número de Akeed.`,
    unsubscribe: 'Dejar de recibir anuncios',
  },
  fr: {
    pool: (a, b, p) =>
      `Votre forfait comprend ${a} messages depuis votre numéro ${p}, en plus des ${b} messages depuis le numéro d’Akeed, au même prix.`,
    once: 'en une seule fois',
    cycle: 'par période de facturation de 30 jours',
    prepaid: (a, b, p) =>
      `Un message depuis votre numéro coûte ${a} crédit (${p} EGP par crédit), contre ${b} crédits depuis le numéro d’Akeed.`,
    unsubscribe: 'Se désabonner des annonces',
  },
  tr: {
    pool: (a, b, p) =>
      `Planınız aynı fiyatla kendi numaranızdan ${a} mesaj ${p} içerir; Akeed numarasından ${b} mesaja ek olarak.`,
    once: 'tek seferlik',
    cycle: 'her 30 günlük fatura döneminde',
    prepaid: (a, b, p) =>
      `Kendi numaranızdan bir mesaj ${a} kredi (${p} EGP/kredi), Akeed numarasından ise ${b} kredidir.`,
    unsubscribe: 'Duyuru aboneliğinden çık',
  },
};

export function announcementPlanLine(
  locale: InterfaceLocale,
  source: { platformType: string; billingPlanId: string | null },
  storedCreditPriceMinor: number,
): string | null {
  const copy = planCopy[locale];
  const number = (n: number) =>
    new Intl.NumberFormat(`${locale === 'es' ? 'es-419' : locale}-u-nu-latn`, {
      maximumFractionDigits: 2,
    }).format(n);
  if (PREPAID_CREDIT_PLATFORMS.includes(source.platformType))
    return copy.prepaid(
      number(CREDITS_PER_OWN_NUMBER_MESSAGE),
      number(CREDITS_PER_AKEED_MESSAGE),
      number(displayedUnitPriceMinor(storedCreditPriceMinor) / 100),
    );
  if (
    source.platformType !== 'shopify' ||
    !source.billingPlanId ||
    !isBillingPlanId(source.billingPlanId)
  )
    return null;
  return copy.pool(
    number(resolveOwnNumberIncludedVerifications(source.billingPlanId)),
    number(resolveIncludedVerificationsLimit(source.billingPlanId)),
    isOneTimeBillingPlan(source.billingPlanId) ? copy.once : copy.cycle,
  );
}

export const escapeAnnouncementHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export function renderAnnouncement(
  email: AnnouncementEmail,
  locale: InterfaceLocale,
  values: AnnouncementValues,
  unsubscribeUrl: string,
): { subject: string; text: string; html: string } | { missing: string } {
  const content =
    email.translations.find((t) => t.locale === locale) ??
    email.translations.find((t) => t.locale === 'en');
  if (!content) return { missing: 'email_content' };
  let missing: string | null = null;
  const text = content.body.replace(
    /\{([a-zA-Z]+)\}/g,
    (_match, key: string) => {
      const value = values[key as keyof AnnouncementValues];
      if (!value?.trim()) missing = key;
      return value ?? '';
    },
  );
  if (missing) return { missing };
  const htmlText = escapeAnnouncementHtml(text)
    .replace(/https:\/\/[^\s<]+/g, (url) => `<a href="${url}">${url}</a>`)
    .replace(/\n/g, '<br>');
  return {
    subject: content.subject,
    text: `${text}\n\n${planCopy[locale].unsubscribe}: ${unsubscribeUrl}`,
    html: `<html lang="${content.locale}" dir="${['ar', 'ur'].includes(content.locale) ? 'rtl' : 'ltr'}"><body style="font-family:Arial,sans-serif;line-height:1.7"><div lang="${content.locale}" dir="${['ar', 'ur'].includes(content.locale) ? 'rtl' : 'ltr'}">${htmlText}<p><a href="${escapeAnnouncementHtml(unsubscribeUrl)}">${planCopy[locale].unsubscribe}</a></p></div></body></html>`,
  };
}
