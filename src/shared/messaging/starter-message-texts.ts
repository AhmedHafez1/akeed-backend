import {
  DEFAULT_MESSAGE_TEXT_STYLE,
  type MessageTextPurpose,
} from './message-texts.types';
import type { TemplateLanguage } from './template-registry.types';

/**
 * The free-form texts migration 0064 writes for Urdu, Spanish and French: the
 * two acknowledgments, the nudge after an unreadable reply, and the words used
 * when a customer or store name is missing. Arabic and English have none here:
 * staff wrote theirs in the admin message texts section.
 *
 * These are plain messages, not provider templates, so they need no approval.
 * They are only read for a customer whose message went out in that language,
 * which cannot happen before the language has an approved default template.
 *
 * The migration repeats this text, and a spec keeps the two the same.
 */
export interface StarterMessageText {
  purpose: MessageTextPurpose;
  language: TemplateLanguage;
  style: string;
  body: string;
}

const text = (
  language: TemplateLanguage,
  purpose: MessageTextPurpose,
  body: string,
): StarterMessageText => ({
  purpose,
  language,
  style: DEFAULT_MESSAGE_TEXT_STYLE,
  body,
});

export const STARTER_MESSAGE_TEXTS: readonly StarterMessageText[] = [
  text(
    'ur',
    'ack_confirmed',
    'شکریہ! {{store}} پر آپ کا آرڈر {{order}} کنفرم ہو گیا ہے اور جلد روانہ کر دیا جائے گا۔',
  ),
  text(
    'ur',
    'ack_canceled',
    'آپ کا آرڈر {{order}} منسوخ کر دیا گیا ہے۔ {{store}} کو آگاہ کرنے کا شکریہ۔',
  ),
  text(
    'ur',
    'unresolved_reply_nudge',
    'معذرت، ہم آپ کا جواب نہیں سمجھ سکے۔ براہِ کرم اوپر والے پیغام کے بٹن سے اپنے آرڈر کی تصدیق یا منسوخی کریں۔',
  ),
  text('ur', 'fallback_customer_name', 'محترم صارف'),
  text('ur', 'fallback_store_name', 'ہمارے اسٹور'),
  text(
    'es',
    'ack_confirmed',
    '¡Gracias! Tu pedido {{order}} en {{store}} está confirmado y pronto estará en camino.',
  ),
  text(
    'es',
    'ack_canceled',
    'Tu pedido {{order}} ha sido cancelado. Gracias por avisar a {{store}}.',
  ),
  text(
    'es',
    'unresolved_reply_nudge',
    'Disculpa, no hemos entendido tu respuesta. Usa los botones del mensaje anterior para confirmar o cancelar tu pedido.',
  ),
  text('es', 'fallback_customer_name', 'estimado cliente'),
  text('es', 'fallback_store_name', 'nuestra tienda'),
  text(
    'fr',
    'ack_confirmed',
    'Merci, votre commande {{order}} sur {{store}} est bien confirmée. Elle sera expédiée très bientôt.',
  ),
  text(
    'fr',
    'ack_canceled',
    "Votre commande {{order}} a bien été annulée. Merci d'avoir prévenu {{store}}.",
  ),
  text(
    'fr',
    'unresolved_reply_nudge',
    "Désolé, nous n'avons pas compris votre réponse. Utilisez les boutons du message précédent pour confirmer ou annuler votre commande.",
  ),
  text('fr', 'fallback_customer_name', 'cher client'),
  text('fr', 'fallback_store_name', 'notre boutique'),
];
