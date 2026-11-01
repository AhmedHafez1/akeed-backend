import type { UsageAlertLanguage } from './usage-alert-copy';

export interface CreditModelNoticeEmail {
  subject: string;
  text: string;
  html: string;
}

interface Copy {
  subject: string;
  greeting: (store: string | null) => string;
  lines: string[];
  open: string;
}

const COPY: Record<UsageAlertLanguage, Copy> = {
  en: {
    subject: 'Your Akeed balance now shows in EGP value',
    greeting: (store) => (store ? `Hello ${store},` : 'Hello,'),
    lines: [
      'Your credit balance number has doubled. Its value is the same, and no money has moved.',
      '1 credit now equals EGP 1, and each WhatsApp message from Akeed uses 2 credits. A message still costs EGP 2.',
      'For example, a balance of 100 credits now shows as 200 credits and still sends 100 messages.',
    ],
    open: 'Open Akeed',
  },
  ar: {
    subject: 'رصيدك في أكيد يظهر الآن بقيمته بالجنيه',
    greeting: (store) => (store ? `مرحبًا ${store}،` : 'مرحبًا،'),
    lines: [
      'تضاعف رقم رصيدك، وقيمته كما هي، ولم تتحرك أي أموال.',
      'أصبح الرصيد الواحد يساوي جنيهًا مصريًا واحدًا، وتستخدم كل رسالة واتساب من أكيد 2 رصيد. تكلفة الرسالة ما زالت جنيهين.',
      'مثال: 100 رصيد أصبحت 200 رصيد، وما زالت ترسل 100 رسالة.',
    ],
    open: 'افتح أكيد',
  },
  ur: {
    subject: 'آپ کا اکید بیلنس اب مصری پاؤنڈ کی قدر میں دکھایا جاتا ہے',
    greeting: (store) => (store ? `السلام علیکم ${store}،` : 'السلام علیکم،'),
    lines: [
      'آپ کے کریڈٹ بیلنس کا عدد دگنا ہو گیا ہے۔ اس کی قدر وہی ہے اور کوئی رقم منتقل نہیں ہوئی۔',
      'اب 1 کریڈٹ 1 مصری پاؤنڈ کے برابر ہے، اور اکید کا ہر واٹس ایپ پیغام 2 کریڈٹ استعمال کرتا ہے۔ ایک پیغام کی قیمت اب بھی 2 مصری پاؤنڈ ہے۔',
      'مثال کے طور پر، 100 کریڈٹ کا بیلنس اب 200 کریڈٹ دکھاتا ہے اور اب بھی 100 پیغامات بھیجتا ہے۔',
    ],
    open: 'اکید کھولیں',
  },
  es: {
    subject: 'Tu saldo de Akeed ahora se muestra en valor en EGP',
    greeting: (store) => (store ? `Hola, ${store}:` : 'Hola:'),
    lines: [
      'El número de tu saldo de créditos se duplicó. Su valor es el mismo y no hubo ningún movimiento de dinero.',
      'Ahora 1 crédito equivale a EGP 1, y cada mensaje de WhatsApp de Akeed usa 2 créditos. Un mensaje sigue costando EGP 2.',
      'Por ejemplo, un saldo de 100 créditos ahora se muestra como 200 créditos y sigue enviando 100 mensajes.',
    ],
    open: 'Abrir Akeed',
  },
  fr: {
    subject: 'Votre solde Akeed s’affiche désormais en valeur EGP',
    greeting: (store) => (store ? `Bonjour ${store},` : 'Bonjour,'),
    lines: [
      'Le nombre affiché pour votre solde de crédits a doublé. Sa valeur reste la même et aucun argent n’a bougé.',
      'Désormais, 1 crédit vaut 1 EGP et chaque message WhatsApp d’Akeed utilise 2 crédits. Un message coûte toujours 2 EGP.',
      'Par exemple, un solde de 100 crédits s’affiche maintenant comme 200 crédits et envoie toujours 100 messages.',
    ],
    open: 'Ouvrir Akeed',
  },
  tr: {
    subject: 'Akeed bakiyeniz artık EGP değeriyle gösteriliyor',
    greeting: (store) => (store ? `Merhaba ${store},` : 'Merhaba,'),
    lines: [
      'Kredi bakiyenizdeki sayı iki katına çıktı. Değeri aynı ve hiçbir para hareketi olmadı.',
      'Artık 1 kredi 1 EGP’ye eşit ve Akeed’den gönderilen her WhatsApp mesajı 2 kredi kullanıyor. Bir mesajın maliyeti yine 2 EGP.',
      'Örneğin 100 kredilik bir bakiye artık 200 kredi olarak görünüyor ve yine 100 mesaj gönderiyor.',
    ],
    open: 'Akeed’i aç',
  },
};

const RTL_LANGUAGES: readonly UsageAlertLanguage[] = ['ar', 'ur'];

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildCreditModelNoticeEmail(
  language: UsageAlertLanguage,
  facts: { storeName: string | null; dashboardUrl: string | null },
): CreditModelNoticeEmail {
  const copy = COPY[language];
  const lines = [copy.greeting(facts.storeName), ...copy.lines];
  const text = [
    ...lines,
    ...(facts.dashboardUrl ? [`${copy.open}: ${facts.dashboardUrl}`] : []),
  ].join('\n\n');
  const paragraphs = lines.map((line) => `<p>${escapeHtml(line)}</p>`);
  if (facts.dashboardUrl) {
    paragraphs.push(
      `<p><a href="${escapeHtml(facts.dashboardUrl)}">${escapeHtml(copy.open)}</a></p>`,
    );
  }
  const dir = RTL_LANGUAGES.includes(language) ? 'rtl' : 'ltr';
  return {
    subject: copy.subject,
    text,
    html: `<div dir="${dir}" lang="${language}">${paragraphs.join('')}</div>`,
  };
}
