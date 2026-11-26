import type { SelectedCodTemplate } from '../messaging/cod-template-selector';
import { resolveTemplateLanguageForPhone } from '../messaging/template-language';
import { isSendableReviewStatus } from '../messaging/template-provider.types';
import {
  SHIPPING_SHIPPED_PURPOSE,
  type RegistryTemplate,
  type TemplateLanguage,
} from '../messaging/template-registry.types';
import {
  isLiveLanguage,
  toSelectedTemplate,
  type TemplateSendGuardrail,
} from '../messaging/template-selector';

export type ShippingTemplateSelection =
  | {
      template: SelectedCodTemplate;
      /** The language the store's confirmation rules chose. */
      requestedLanguage: TemplateLanguage;
      /** Present when another language stood in for it. */
      fallbackReason?: 'language_unavailable';
    }
  | { template: null; requestedLanguage: TemplateLanguage };

/**
 * A Shipped template may go out only once the provider has approved it, even
 * before this environment's first sync: an unapproved template would be
 * refused, and a refusal still costs the order its one message.
 */
function sendableShippingDefault(
  templates: readonly RegistryTemplate[],
  language: TemplateLanguage,
): RegistryTemplate | undefined {
  return templates.find(
    (template) =>
      template.purpose === SHIPPING_SHIPPED_PURPOSE &&
      template.language === language &&
      template.isDefault &&
      template.isActive &&
      !template.changeRequestOfKey &&
      isSendableReviewStatus(template.reviewStatus),
  );
}

/**
 * Picks the Shipped template. The language is chosen exactly as for the
 * store's confirmations. If it has no approved Shipped template, the phone's
 * base language (Arabic for an Arabic country code, English otherwise) stands
 * in, then the other of the two. With none approved there is nothing to send.
 */
export function selectShippingTemplate(
  templates: readonly RegistryTemplate[],
  params: {
    preferredLanguage?: string | null;
    phoneNumber: string | null | undefined;
    orderLanguage?: string | null;
    guardrail?: TemplateSendGuardrail;
  },
): ShippingTemplateSelection {
  const phone = params.phoneNumber ?? '';
  const requestedLanguage = resolveTemplateLanguageForPhone(
    params.preferredLanguage,
    phone,
    (candidate) => isLiveLanguage(templates, candidate, params.guardrail),
    params.orderLanguage,
  );
  const base: TemplateLanguage = resolveTemplateLanguageForPhone(null, phone);
  const other: TemplateLanguage = base === 'ar' ? 'en' : 'ar';
  const candidates: TemplateLanguage[] = [requestedLanguage, base, other];
  const chain = candidates.filter(
    (language, index) => candidates.indexOf(language) === index,
  );
  for (const language of chain) {
    const template = sendableShippingDefault(templates, language);
    if (template)
      return {
        // The synced text goes along so the sender can find the Track order
        // button and fill the end of its link.
        template: {
          ...toSelectedTemplate(template),
          ...(template.components ? { components: template.components } : {}),
        },
        requestedLanguage,
        ...(language !== requestedLanguage
          ? { fallbackReason: 'language_unavailable' as const }
          : {}),
      };
  }
  return { template: null, requestedLanguage };
}
