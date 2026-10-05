import type {
  TemplateLanguage,
  TemplateParameterFormat,
  TemplateVariable,
} from './template-registry.types';

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
  /** `<language>.<style>`, for example `ar.egyptian`. */
  variantKey: string;
  language: TemplateLanguage;
  templateName: string;
  languageCode: string;
}

/**
 * A template resolved for one send, with what an adapter needs to fill it:
 * the registry's parameter format and its variables in send order.
 */
export interface SelectedCodTemplate extends SentTemplateIdentity {
  parameterFormat: TemplateParameterFormat;
  variables: readonly TemplateVariable[];
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
