import type {
  CapacityAction,
  UsageAlertLevel,
} from '../billing/usage-alert.policy';

/**
 * The text of a usage alert email, in the store's language.
 *
 * The backend stores no interface language, so the store's WhatsApp message
 * language is used; `auto` falls back to Arabic, the app's default.
 */

export const USAGE_ALERT_LANGUAGES = [
  'ar',
  'en',
  'ur',
  'es',
  'fr',
  'tr',
] as const;
export type UsageAlertLanguage = (typeof USAGE_ALERT_LANGUAGES)[number];

export interface UsageAlertFacts {
  level: UsageAlertLevel;
  storeName: string | null;
  /** Plan alerts: confirmations used and included this period. */
  used?: number;
  limit?: number;
  /** Credit alerts: credits left to send with. */
  availableCredits?: number;
  blockedCount: number;
  action: CapacityAction;
  /** The next allowance reset, YYYY-MM-DD, when the plan has one. */
  resetDate: string | null;
  dashboardUrl: string | null;
}

export interface UsageAlertEmail {
  subject: string;
  text: string;
  html: string;
}

interface Copy {
  subject: Record<UsageAlertLevel, string>;
  greeting: (store: string | null) => string;
  usage: (used: number, limit: number) => string;
  credits: (available: number) => string;
  blocked: (count: number) => string;
  upgrade: string;
  recharge: string;
  waitReset: (date: string) => string;
  orWaitReset: (date: string) => string;
  open: string;
}

const COPY: Record<UsageAlertLanguage, Copy> = {
  en: {
    subject: {
      '80': 'You have used 80% of your Akeed confirmations',
      '95': 'You have used 95% of your Akeed confirmations',
      '100': 'Akeed has paused order confirmations',
      low: 'Your Akeed credits are running low',
      depleted: 'Akeed has paused order confirmations',
    },
    greeting: (store) => (store ? `Hello ${store},` : 'Hello,'),
    usage: (used, limit) =>
      `You have used ${used} of ${limit} WhatsApp confirmations in this period.`,
    credits: (available) => `You have ${available} credits left.`,
    blocked: (count) =>
      `${count} orders are waiting. Akeed sends them automatically once you can send again.`,
    upgrade: 'Upgrade your plan to keep confirming orders.',
    recharge: 'Buy credits to keep confirming orders.',
    waitReset: (date) => `Your allowance resets on ${date}.`,
    orWaitReset: (date) => `Or wait for your allowance to reset on ${date}.`,
    open: 'Open Akeed',
  },
  ar: {
    subject: {
      '80': 'استخدمت 80% من تأكيدات أكيد',
      '95': 'استخدمت 95% من تأكيدات أكيد',
      '100': 'أوقف أكيد تأكيد الطلبات مؤقتًا',
      low: 'رصيدك في أكيد يوشك على النفاد',
      depleted: 'أوقف أكيد تأكيد الطلبات مؤقتًا',
    },
    greeting: (store) => (store ? `مرحبًا ${store}،` : 'مرحبًا،'),
    usage: (used, limit) =>
      `استخدمت ${used} من ${limit} تأكيدًا عبر واتساب في هذه الفترة.`,
    credits: (available) => `تبقى لديك ${available} رصيدًا.`,
    blocked: (count) =>
      `عدد الطلبات المنتظرة ${count}. يرسلها أكيد تلقائيًا عندما يصبح الإرسال متاحًا من جديد.`,
    upgrade: 'رقِّ باقتك لمواصلة تأكيد الطلبات.',
    recharge: 'اشترِ رصيدًا لمواصلة تأكيد الطلبات.',
    waitReset: (date) => `يتجدد رصيد باقتك في ${date}.`,
    orWaitReset: (date) => `أو انتظر تجدد رصيد باقتك في ${date}.`,
    open: 'افتح أكيد',
  },
  ur: {
    subject: {
      '80': 'آپ اکید کی 80% تصدیقات استعمال کر چکے ہیں',
      '95': 'آپ اکید کی 95% تصدیقات استعمال کر چکے ہیں',
      '100': 'اکید نے آرڈرز کی تصدیق عارضی طور پر روک دی ہے',
      low: 'آپ کے اکید کریڈٹس کم ہو رہے ہیں',
      depleted: 'اکید نے آرڈرز کی تصدیق عارضی طور پر روک دی ہے',
    },
    greeting: (store) => (store ? `السلام علیکم ${store}،` : 'السلام علیکم،'),
    usage: (used, limit) =>
      `اس مدت میں آپ ${limit} میں سے ${used} واٹس ایپ تصدیقات استعمال کر چکے ہیں۔`,
    credits: (available) => `آپ کے پاس ${available} کریڈٹس باقی ہیں۔`,
    blocked: (count) =>
      `${count} آرڈرز انتظار میں ہیں۔ دوبارہ بھیجنا ممکن ہوتے ہی اکید انہیں خود بھیج دے گا۔`,
    upgrade: 'آرڈرز کی تصدیق جاری رکھنے کے لیے اپنا پلان اپ گریڈ کریں۔',
    recharge: 'آرڈرز کی تصدیق جاری رکھنے کے لیے کریڈٹس خریدیں۔',
    waitReset: (date) => `آپ کا کوٹہ ${date} کو دوبارہ شروع ہوگا۔`,
    orWaitReset: (date) =>
      `یا ${date} کو کوٹہ دوبارہ شروع ہونے کا انتظار کریں۔`,
    open: 'اکید کھولیں',
  },
  es: {
    subject: {
      '80': 'Has usado el 80% de tus confirmaciones de Akeed',
      '95': 'Has usado el 95% de tus confirmaciones de Akeed',
      '100': 'Akeed pausó la confirmación de pedidos',
      low: 'Te quedan pocos créditos de Akeed',
      depleted: 'Akeed pausó la confirmación de pedidos',
    },
    greeting: (store) => (store ? `Hola, ${store}:` : 'Hola:'),
    usage: (used, limit) =>
      `Has usado ${used} de ${limit} confirmaciones por WhatsApp en este periodo.`,
    credits: (available) => `Te quedan ${available} créditos.`,
    blocked: (count) =>
      `Hay ${count} pedidos en espera. Akeed los enviará automáticamente en cuanto puedas volver a enviar.`,
    upgrade: 'Mejora tu plan para seguir confirmando pedidos.',
    recharge: 'Compra créditos para seguir confirmando pedidos.',
    waitReset: (date) => `Tu cupo se renueva el ${date}.`,
    orWaitReset: (date) => `O espera a que tu cupo se renueve el ${date}.`,
    open: 'Abrir Akeed',
  },
  fr: {
    subject: {
      '80': 'Vous avez utilisé 80 % de vos confirmations Akeed',
      '95': 'Vous avez utilisé 95 % de vos confirmations Akeed',
      '100': 'Akeed a suspendu la confirmation des commandes',
      low: 'Vos crédits Akeed sont presque épuisés',
      depleted: 'Akeed a suspendu la confirmation des commandes',
    },
    greeting: (store) => (store ? `Bonjour ${store},` : 'Bonjour,'),
    usage: (used, limit) =>
      `Vous avez utilisé ${used} confirmations WhatsApp sur ${limit} pendant cette période.`,
    credits: (available) => `Il vous reste ${available} crédits.`,
    blocked: (count) =>
      `${count} commandes sont en attente. Akeed les enverra automatiquement dès que l’envoi sera de nouveau possible.`,
    upgrade:
      'Passez à une offre supérieure pour continuer à confirmer vos commandes.',
    recharge: 'Achetez des crédits pour continuer à confirmer vos commandes.',
    waitReset: (date) => `Votre quota sera renouvelé le ${date}.`,
    orWaitReset: (date) =>
      `Ou attendez le renouvellement de votre quota le ${date}.`,
    open: 'Ouvrir Akeed',
  },
  tr: {
    subject: {
      '80': 'Akeed onaylarınızın %80’ini kullandınız',
      '95': 'Akeed onaylarınızın %95’ini kullandınız',
      '100': 'Akeed sipariş onaylarını duraklattı',
      low: 'Akeed krediniz azalıyor',
      depleted: 'Akeed sipariş onaylarını duraklattı',
    },
    greeting: (store) => (store ? `Merhaba ${store},` : 'Merhaba,'),
    usage: (used, limit) =>
      `Bu dönemde ${limit} WhatsApp onayından ${used} tanesini kullandınız.`,
    credits: (available) => `${available} krediniz kaldı.`,
    blocked: (count) =>
      `${count} sipariş bekliyor. Gönderim yeniden mümkün olduğunda Akeed bunları otomatik olarak gönderir.`,
    upgrade: 'Siparişleri onaylamaya devam etmek için planınızı yükseltin.',
    recharge: 'Siparişleri onaylamaya devam etmek için kredi satın alın.',
    waitReset: (date) => `Kotanız ${date} tarihinde yenilenir.`,
    orWaitReset: (date) =>
      `Ya da kotanızın ${date} tarihinde yenilenmesini bekleyin.`,
    open: 'Akeed’i aç',
  },
};

/** The email language for a store's message language setting. */
export function usageAlertLanguage(
  defaultLanguage: string | null | undefined,
): UsageAlertLanguage {
  return (USAGE_ALERT_LANGUAGES as readonly string[]).includes(
    defaultLanguage ?? '',
  )
    ? (defaultLanguage as UsageAlertLanguage)
    : 'ar';
}

const RTL_LANGUAGES: readonly UsageAlertLanguage[] = ['ar', 'ur'];

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildUsageAlertEmail(
  language: UsageAlertLanguage,
  facts: UsageAlertFacts,
): UsageAlertEmail {
  const copy = COPY[language];
  const lines: string[] = [copy.greeting(facts.storeName)];
  if (facts.used !== undefined && facts.limit !== undefined) {
    lines.push(copy.usage(facts.used, facts.limit));
  }
  if (facts.availableCredits !== undefined) {
    lines.push(copy.credits(Math.max(facts.availableCredits, 0)));
  }
  if (facts.blockedCount > 0) lines.push(copy.blocked(facts.blockedCount));
  if (facts.action === 'recharge') lines.push(copy.recharge);
  else if (facts.action === 'wait_reset' && facts.resetDate)
    lines.push(copy.waitReset(facts.resetDate));
  else if (facts.action === 'upgrade') {
    lines.push(copy.upgrade);
    if (facts.resetDate) lines.push(copy.orWaitReset(facts.resetDate));
  }

  const text = [
    ...lines,
    ...(facts.dashboardUrl ? [`${copy.open}: ${facts.dashboardUrl}`] : []),
  ].join('\n\n');
  const dir = RTL_LANGUAGES.includes(language) ? 'rtl' : 'ltr';
  const paragraphs = lines.map((line) => `<p>${escapeHtml(line)}</p>`);
  if (facts.dashboardUrl) {
    paragraphs.push(
      `<p><a href="${escapeHtml(facts.dashboardUrl)}">${escapeHtml(copy.open)}</a></p>`,
    );
  }
  const html = `<div dir="${dir}" lang="${language}">${paragraphs.join('')}</div>`;
  return { subject: copy.subject[facts.level], text, html };
}
