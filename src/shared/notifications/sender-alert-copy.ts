import type { SenderAlert } from './sender-alert.policy';
import type { UsageAlertLanguage, UsageAlertEmail } from './usage-alert-copy';

export const WHATSAPP_MANAGER_URL =
  'https://business.facebook.com/wa/manage/home/';
interface Copy {
  fallback: string;
  disconnect: string;
  template_rejection: string;
  quality_drop: string;
  payment: string;
  primary_inactivity: string;
  offboarded: string;
  credentials: string;
  restricted: string;
  explanation: string;
  reconnect: string;
  whatsapp_manager: string;
  review_templates: string;
  none: string;
  open: string;
}

export const SENDER_ALERT_COPY: Record<UsageAlertLanguage, Copy> = {
  en: {
    offboarded:
      'Meta has offboarded your WhatsApp account. Reconnect your number in Akeed.',
    fallback: 'Akeed is using its number for your confirmations',
    disconnect: 'Your WhatsApp number is disconnected',
    template_rejection: 'Some WhatsApp templates need attention',
    quality_drop: 'Your WhatsApp number has low quality',
    payment: 'Your WhatsApp payment method needs attention',
    primary_inactivity:
      'WhatsApp disconnected your number because the Business app was inactive. Reconnect and open the WhatsApp Business app at least every two weeks.',
    credentials: 'Reconnect your number to renew its access permission.',
    restricted:
      'Meta has restricted this number. Review its status in WhatsApp Manager.',
    explanation:
      'Akeed uses its own number when your number cannot send. Normal Akeed-number pricing applies. Check Akeed for the current status of your confirmations.',
    reconnect: 'Reconnect your WhatsApp number in Akeed.',
    whatsapp_manager: 'Review your account in WhatsApp Manager.',
    review_templates:
      'Review the affected templates in Akeed. Rejected, paused, disabled or marketing templates cannot be used for these confirmations.',
    none: 'Akeed will use your number again when it can send.',
    open: 'Open Akeed',
  },
  ar: {
    offboarded: 'أوقفت Meta ربط حساب واتساب الخاص بك. أعد ربط رقمك في أكيد.',
    fallback: 'أكيد يستخدم رقمه لإرسال تأكيداتك',
    disconnect: 'تم فصل رقم واتساب الخاص بك',
    template_rejection: 'بعض قوالب واتساب تحتاج إلى مراجعة',
    quality_drop: 'جودة رقم واتساب الخاص بك منخفضة',
    payment: 'وسيلة الدفع في واتساب تحتاج إلى مراجعة',
    primary_inactivity:
      'فصل واتساب رقمك بسبب عدم نشاط تطبيق واتساب للأعمال. أعد ربط الرقم وافتح تطبيق واتساب للأعمال مرة على الأقل كل أسبوعين.',
    credentials: 'أعد ربط رقمك لتجديد صلاحية الوصول.',
    restricted: 'فرضت Meta قيودًا على هذا الرقم. راجع حالته في مدير واتساب.',
    explanation:
      'يستخدم أكيد رقمه عندما يتعذر الإرسال من رقمك، وتُطبق تكلفة الإرسال المعتادة من رقم أكيد. راجع أكيد لمعرفة حالة تأكيداتك الحالية.',
    reconnect: 'أعد ربط رقم واتساب الخاص بك في أكيد.',
    whatsapp_manager: 'راجع حسابك في مدير واتساب.',
    review_templates:
      'راجع القوالب المتأثرة في أكيد. لا يمكن استخدام القوالب المرفوضة أو الموقوفة أو المعطلة أو التسويقية لهذه التأكيدات.',
    none: 'سيعود أكيد لاستخدام رقمك عندما يصبح قادرًا على الإرسال.',
    open: 'افتح أكيد',
  },
  ur: {
    offboarded:
      'Meta نے آپ کے WhatsApp اکاؤنٹ کا ربط ختم کر دیا ہے۔ Akeed میں اپنا نمبر دوبارہ منسلک کریں۔',
    fallback: 'Akeed آپ کی تصدیقات اپنے نمبر سے بھیج رہا ہے',
    disconnect: 'آپ کا WhatsApp نمبر منقطع ہو گیا ہے',
    template_rejection: 'کچھ WhatsApp ٹیمپلیٹس پر توجہ درکار ہے',
    quality_drop: 'آپ کے WhatsApp نمبر کا معیار کم ہے',
    payment: 'آپ کے WhatsApp ادائیگی کے طریقے پر توجہ درکار ہے',
    primary_inactivity:
      'Business ایپ غیر فعال رہنے کی وجہ سے WhatsApp نے آپ کا نمبر منقطع کر دیا۔ دوبارہ منسلک کریں اور کم از کم ہر دو ہفتے میں WhatsApp Business ایپ کھولیں۔',
    credentials: 'رسائی کی اجازت کی تجدید کے لیے اپنا نمبر دوبارہ منسلک کریں۔',
    restricted:
      'Meta نے اس نمبر پر پابندیاں لگائی ہیں۔ WhatsApp Manager میں اس کی حالت دیکھیں۔',
    explanation:
      'جب آپ کے نمبر سے بھیجنا ممکن نہ ہو تو Akeed اپنا نمبر استعمال کرتا ہے۔ Akeed کے نمبر کی معمول کی قیمت لاگو ہوتی ہے۔ تصدیقات کی موجودہ حالت Akeed میں دیکھیں۔',
    reconnect: 'Akeed میں اپنا WhatsApp نمبر دوبارہ منسلک کریں۔',
    whatsapp_manager: 'WhatsApp Manager میں اپنا اکاؤنٹ دیکھیں۔',
    review_templates:
      'Akeed میں متاثرہ ٹیمپلیٹس دیکھیں۔ مسترد، موقوف، غیر فعال یا مارکیٹنگ ٹیمپلیٹس ان تصدیقات کے لیے استعمال نہیں ہو سکتے۔',
    none: 'آپ کا نمبر بھیجنے کے قابل ہونے پر Akeed اسے دوبارہ استعمال کرے گا۔',
    open: 'Akeed کھولیں',
  },
  es: {
    offboarded:
      'Meta desvinculó tu cuenta de WhatsApp. Vuelve a conectar tu número en Akeed.',
    fallback: 'Akeed está enviando tus confirmaciones desde su número',
    disconnect: 'Tu número de WhatsApp está desconectado',
    template_rejection: 'Algunas plantillas de WhatsApp necesitan atención',
    quality_drop: 'Tu número de WhatsApp tiene una calidad baja',
    payment: 'Tu método de pago de WhatsApp necesita atención',
    primary_inactivity:
      'WhatsApp desconectó tu número por inactividad de la aplicación Business. Vuelve a conectarlo y abre WhatsApp Business al menos cada dos semanas.',
    credentials:
      'Vuelve a conectar tu número para renovar el permiso de acceso.',
    restricted:
      'Meta restringió este número. Revisa su estado en WhatsApp Manager.',
    explanation:
      'Akeed usa su propio número cuando el tuyo no puede enviar mensajes. Se aplica la tarifa habitual del número de Akeed. Revisa el estado actual de tus confirmaciones en Akeed.',
    reconnect: 'Vuelve a conectar tu número de WhatsApp en Akeed.',
    whatsapp_manager: 'Revisa tu cuenta en WhatsApp Manager.',
    review_templates:
      'Revisa las plantillas afectadas en Akeed. Las plantillas rechazadas, pausadas, deshabilitadas o de marketing no se pueden usar para estas confirmaciones.',
    none: 'Akeed volverá a usar tu número cuando pueda enviar mensajes.',
    open: 'Abrir Akeed',
  },
  fr: {
    offboarded:
      'Meta a dissocié votre compte WhatsApp. Reconnectez votre numéro dans Akeed.',
    fallback: 'Akeed utilise son numéro pour vos confirmations',
    disconnect: 'Votre numéro WhatsApp est déconnecté',
    template_rejection: 'Certains modèles WhatsApp nécessitent votre attention',
    quality_drop: 'La qualité de votre numéro WhatsApp est faible',
    payment: 'Votre moyen de paiement WhatsApp nécessite votre attention',
    primary_inactivity:
      'WhatsApp a déconnecté votre numéro car l’application Business était inactive. Reconnectez-le et ouvrez WhatsApp Business au moins toutes les deux semaines.',
    credentials:
      'Reconnectez votre numéro pour renouveler son autorisation d’accès.',
    restricted:
      'Meta a restreint ce numéro. Consultez son état dans WhatsApp Manager.',
    explanation:
      'Akeed utilise son propre numéro lorsque le vôtre ne peut pas envoyer de messages. Le tarif habituel du numéro Akeed s’applique. Consultez Akeed pour connaître l’état actuel de vos confirmations.',
    reconnect: 'Reconnectez votre numéro WhatsApp dans Akeed.',
    whatsapp_manager: 'Consultez votre compte dans WhatsApp Manager.',
    review_templates:
      'Consultez les modèles concernés dans Akeed. Les modèles refusés, suspendus, désactivés ou marketing ne peuvent pas servir à ces confirmations.',
    none: 'Akeed réutilisera votre numéro lorsqu’il pourra envoyer des messages.',
    open: 'Ouvrir Akeed',
  },
  tr: {
    offboarded:
      'Meta WhatsApp hesabınızın bağlantısını sonlandırdı. Numaranızı Akeed üzerinden yeniden bağlayın.',
    fallback: 'Akeed onaylarınızı kendi numarasından gönderiyor',
    disconnect: 'WhatsApp numaranızın bağlantısı kesildi',
    template_rejection: 'Bazı WhatsApp şablonları ilgilenmenizi gerektiriyor',
    quality_drop: 'WhatsApp numaranızın kalitesi düşük',
    payment: 'WhatsApp ödeme yönteminiz ilgilenmenizi gerektiriyor',
    primary_inactivity:
      'Business uygulaması etkin olmadığı için WhatsApp numaranızın bağlantısını kesti. Yeniden bağlanın ve WhatsApp Business uygulamasını en az iki haftada bir açın.',
    credentials: 'Erişim iznini yenilemek için numaranızı yeniden bağlayın.',
    restricted:
      'Meta bu numarayı kısıtladı. Durumunu WhatsApp Manager üzerinden inceleyin.',
    explanation:
      'Numaranız mesaj gönderemediğinde Akeed kendi numarasını kullanır. Akeed numarasının normal ücretleri geçerlidir. Onaylarınızın güncel durumunu Akeed üzerinden kontrol edin.',
    reconnect: 'WhatsApp numaranızı Akeed üzerinden yeniden bağlayın.',
    whatsapp_manager: 'Hesabınızı WhatsApp Manager üzerinden inceleyin.',
    review_templates:
      'Etkilenen şablonları Akeed üzerinden inceleyin. Reddedilen, duraklatılan, devre dışı bırakılan veya pazarlama şablonları bu onaylarda kullanılamaz.',
    none: 'Numaranız mesaj gönderebildiğinde Akeed onu yeniden kullanacak.',
    open: 'Akeed’i aç',
  },
};

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export function buildSenderAlertEmail(
  language: UsageAlertLanguage,
  alert: SenderAlert,
  dashboardUrl: string | null,
): UsageAlertEmail {
  const copy = SENDER_ALERT_COPY[language];
  const detail = [
    'primary_inactivity',
    'offboarded',
    'credentials',
    'restricted',
  ].includes(alert.reason)
    ? copy[
        alert.reason as
          | 'primary_inactivity'
          | 'offboarded'
          | 'credentials'
          | 'restricted'
      ]
    : copy[alert.action];
  const lines = [copy[alert.kind], detail, copy.explanation];
  const links: { label: string; url: string }[] = [];
  if (alert.action === 'whatsapp_manager')
    links.push({ label: 'WhatsApp Manager', url: WHATSAPP_MANAGER_URL });
  if (dashboardUrl) {
    try {
      const url = new URL(dashboardUrl);
      if (['https:', 'http:'].includes(url.protocol))
        links.push({ label: copy.open, url: url.toString() });
    } catch {
      /* A missing dashboard link must not prevent an alert. */
    }
  }
  return {
    subject: copy[alert.kind],
    text: [...lines, ...links.map((l) => `${l.label}: ${l.url}`)].join('\n\n'),
    html: `<div dir="${['ar', 'ur'].includes(language) ? 'rtl' : 'ltr'}" lang="${language}">${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('')}${links.map((l) => `<p><a href="${escapeHtml(l.url)}">${escapeHtml(l.label)}</a></p>`).join('')}</div>`,
  };
}
