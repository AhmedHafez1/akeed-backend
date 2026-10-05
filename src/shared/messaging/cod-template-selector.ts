import {
  getCodTemplateDefinition,
  isArabicCodTemplateVariant,
  isEnglishCodTemplateVariant,
  type CodTemplateBodyVariableMode,
  type CodTemplateLanguage,
  type CodTemplateVariableKey,
} from './cod-template-catalog';
import { resolveTemplateLanguageForPhone } from './template-language';

/** What a send is for: the first message, the reminder, or a merchant's test. */
export type TemplateSendPurpose = 'initial' | 'reminder' | 'test';

export const TEMPLATE_SEND_PURPOSES = [
  'initial',
  'reminder',
  'test',
] as const satisfies readonly TemplateSendPurpose[];

/**
 * Which template a customer received. `templateName` and `languageCode` are
 * the provider's own strings, carried as opaque values: nothing outside the
 * adapter interprets them.
 */
export interface SentTemplateIdentity {
  /** `<language>.<variant>`, for example `ar.egyptian`. */
  variantKey: string;
  language: CodTemplateLanguage;
  templateName: string;
  languageCode: string;
}

/** A template resolved for one send, with what an adapter needs to fill it. */
export interface SelectedCodTemplate extends SentTemplateIdentity {
  bodyVariableMode: CodTemplateBodyVariableMode;
  bodyParameterOrder: readonly CodTemplateVariableKey[];
}

/**
 * Picks the template for one send from the store's settings and the
 * customer's number. It runs before the dispatch is claimed, so the ledger
 * records the same values the message is built from.
 *
 * A stored variant the catalog does not know resolves to the language default.
 * Selection never throws: it runs before the claim, where a failure would
 * leave no ledger row to record it on. A missing number is read like a local
 * number without a country code.
 */
export function selectCodTemplate(params: {
  preferredLanguage?: string | null;
  phoneNumber: string | null | undefined;
  arVariant?: string | null;
  enVariant?: string | null;
}): SelectedCodTemplate {
  const language = resolveTemplateLanguageForPhone(
    params.preferredLanguage,
    params.phoneNumber ?? '',
  );
  const definition = getCodTemplateDefinition({
    language,
    selection: {
      ar:
        params.arVariant && isArabicCodTemplateVariant(params.arVariant)
          ? params.arVariant
          : undefined,
      en:
        params.enVariant && isEnglishCodTemplateVariant(params.enVariant)
          ? params.enVariant
          : undefined,
    },
  });

  return {
    variantKey: `${definition.language}.${definition.variant}`,
    language: definition.language,
    templateName: definition.metaTemplateName,
    languageCode: definition.metaLanguageCode,
    bodyVariableMode: definition.bodyVariableMode,
    bodyParameterOrder: definition.bodyParameterOrder,
  };
}

/** The identity part of a selection, without the fill instructions. */
export function toSentTemplateIdentity(
  template: SentTemplateIdentity,
): SentTemplateIdentity {
  return {
    variantKey: template.variantKey,
    language: template.language,
    templateName: template.templateName,
    languageCode: template.languageCode,
  };
}

/**
 * A send to a test order is a test whatever its kind. Otherwise a follow-up is
 * the reminder and anything else is the first message.
 */
export function resolveTemplateSendPurpose(params: {
  kind: 'initial' | 'follow_up';
  isTestOrder: boolean;
}): TemplateSendPurpose {
  if (params.isTestOrder) return 'test';
  return params.kind === 'follow_up' ? 'reminder' : 'initial';
}
