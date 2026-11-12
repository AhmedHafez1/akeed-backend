import type { BillingPlanId } from '../billing/billing-plan';
import { changeRequestDashboardLink } from './change-request-email';
import type { UsageAlertLanguage } from './usage-alert-copy';

const COPY: Record<
  UsageAlertLanguage,
  {
    subject: string;
    body: string;
    previous: (plan: string) => string;
    action: string;
  }
> = {
  en: {
    subject: 'Choose a plan to resume Akeed confirmations',
    body: 'Setup is saved, but your store has no active plan. Order confirmations will not send until you choose a plan.',
    previous: (plan) =>
      `Your ${plan} subscription ended when the app was removed. Choose it again to resume.`,
    action: 'Choose a plan',
  },
  ar: {
    subject: 'اختار باقة عشان ترجع تأكيدات الطلبات في أكيد',
    body: 'إعداداتك اتحفظت، لكن متجرك مفيهوش باقة نشطة. تأكيدات الطلبات مش هتتبعت لحد ما تختار باقة.',
    previous: (plan) =>
      `اشتراكك في باقة ${plan} انتهى لما حذفت التطبيق. اختارها تاني عشان ترجع التأكيدات.`,
    action: 'اختار باقة',
  },
  ur: {
    subject: 'اکید کی تصدیقات بحال کرنے کے لیے پلان منتخب کریں',
    body: 'سیٹ اپ محفوظ ہے، مگر آپ کے اسٹور کا کوئی فعال پلان نہیں۔ پلان منتخب کرنے تک آرڈر کی تصدیقات نہیں بھیجی جائیں گی۔',
    previous: (plan) =>
      `ایپ ہٹانے پر آپ کی ${plan} سبسکرپشن ختم ہو گئی۔ بحال کرنے کے لیے اسے دوبارہ منتخب کریں۔`,
    action: 'پلان منتخب کریں',
  },
  es: {
    subject: 'Elige un plan para reanudar las confirmaciones de Akeed',
    body: 'La configuración está guardada, pero tu tienda no tiene un plan activo. Las confirmaciones no se enviarán hasta que elijas un plan.',
    previous: (plan) =>
      `Tu suscripción ${plan} terminó al eliminar la app. Elígela de nuevo para reanudar las confirmaciones.`,
    action: 'Elegir un plan',
  },
  fr: {
    subject: 'Choisissez un forfait pour reprendre les confirmations Akeed',
    body: 'La configuration est enregistrée, mais votre boutique n’a aucun forfait actif. Les confirmations ne seront pas envoyées avant le choix d’un forfait.',
    previous: (plan) =>
      `Votre abonnement ${plan} a pris fin à la suppression de l’application. Choisissez-le à nouveau pour reprendre.`,
    action: 'Choisir un forfait',
  },
  tr: {
    subject: 'Akeed onaylarını sürdürmek için bir plan seçin',
    body: 'Kurulum kaydedildi ancak mağazanızın etkin bir planı yok. Plan seçene kadar sipariş onayları gönderilmeyecek.',
    previous: (plan) =>
      `Uygulama kaldırıldığında ${plan} aboneliğiniz sona erdi. Devam etmek için yeniden seçin.`,
    action: 'Plan seçin',
  },
};
const escape = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

export function planSelectionLink(
  shop: string,
  language: UsageAlertLanguage,
  apiKey?: string,
): string | null {
  const base = changeRequestDashboardLink({
    language,
    platformType: 'shopify',
    platformStoreUrl: shop,
    shopifyApiKey: apiKey,
    verificationId: '',
    dashboardUrl: null,
  });
  if (!base) return null;
  const link = new URL(base);
  link.pathname = link.pathname.replace(/\/verifications$/, '/settings');
  link.search = '?tab=plan';
  return link.toString();
}

export function buildPlanRequiredEmail(
  language: UsageAlertLanguage,
  facts: {
    link: string;
    previousPlan: BillingPlanId | null;
    cancelled: boolean;
  },
) {
  const copy = COPY[language];
  const names =
    language === 'ar'
      ? {
          starter: 'البداية',
          basic: 'الأساسية',
          pro: 'الاحترافية',
          business: 'الأعمال',
        }
      : { starter: 'Starter', basic: 'Basic', pro: 'Pro', business: 'Scale' };
  const previous =
    facts.cancelled && facts.previousPlan && facts.previousPlan !== 'starter'
      ? copy.previous(names[facts.previousPlan])
      : null;
  const lines = [copy.body, ...(previous ? [previous] : [])];
  return {
    subject: copy.subject,
    text: [...lines, `${copy.action}: ${facts.link}`].join('\n\n'),
    html: `<div lang="${language}" dir="${language === 'ar' || language === 'ur' ? 'rtl' : 'ltr'}">${lines.map((line) => `<p>${escape(line)}</p>`).join('')}<p><a href="${escape(facts.link)}">${escape(copy.action)}</a></p></div>`,
  };
}
