import type {
  TemplateCategory,
  TemplateReviewStatus,
} from './template-provider.types';
import type {
  TemplateLanguage,
  TemplateParameterFormat,
  TemplatePurpose,
  TemplateVariableKey,
} from './template-registry.types';
import type { TemplateTextSegment } from './template-text.types';

/**
 * Where a staff-written template is on its way to the provider.
 *
 * - `draft`: lives only in Akeed and can be changed.
 * - `submitting`: one submit is in flight.
 * - `submit_unknown`: the provider's answer never arrived. Nothing is sent
 *   again until staff have checked the provider.
 * - `submitted`: the provider holds it; its review status is on the registry
 *   row.
 */
export type TemplateDraftState =
  | 'draft'
  | 'submitting'
  | 'submit_unknown'
  | 'submitted';

export type TemplateDraftSamples = Partial<Record<TemplateVariableKey, string>>;

/** What an operator writes. `body` uses `{{customer}}`-style placeholders. */
export interface TemplateDraftContent {
  purpose: TemplatePurpose;
  language: TemplateLanguage;
  /** The base style, for example `egyptian`, without a version. */
  style: string;
  version: number;
  templateName: string;
  languageCode: string;
  parameterFormat: TemplateParameterFormat;
  category: TemplateCategory;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  samples: TemplateDraftSamples;
}

/** One variable of a draft and the provider parameter that carries it. */
export interface TemplateDraftVariable {
  key: TemplateVariableKey;
  /** The provider's parameter name, or its position from 1 as a string. */
  parameter: string;
  sample: string;
}

export type TemplateDraftField =
  | 'name'
  | 'language_code'
  | 'style'
  | 'category'
  | 'body'
  | 'variables'
  | 'samples'
  | 'buttons'
  | 'confirm_label'
  | 'cancel_label';

/**
 * One validation finding. `rule` is stable and translated by the UI;
 * `finding` names the US-08-01 contract-record finding the rule enforces, or
 * `akeed` for a rule of Akeed's own. A `warning` does not block a submit.
 */
export interface TemplateDraftIssue {
  field: TemplateDraftField;
  rule: string;
  finding: string;
  severity: 'error' | 'warning';
}

/** Why the provider rejected a template in review, in neutral terms. */
export type TemplateRejectionReason =
  | 'abusive_content'
  | 'incorrect_category'
  | 'invalid_format'
  | 'promotional'
  | 'scam'
  | 'tag_content_mismatch'
  | 'none'
  | 'unknown';

/** A template ready for the provider, with no provider syntax in it. */
export interface TemplateSubmission {
  templateName: string;
  languageCode: string;
  category: TemplateCategory;
  parameterFormat: TemplateParameterFormat;
  /** `parameter` is the provider parameter, as in `TemplateDraftVariable`. */
  body: TemplateTextSegment[];
  /** A sample value for each provider parameter, in first-use order. */
  samples: { parameter: string; sample: string }[];
  /** Quick replies in send order: the first is index 0 at send time. */
  buttons: { kind: 'quick_reply'; text: string }[];
}

/** What can change in an edit: the text. Name, language and format cannot. */
export type TemplateEditSubmission = Pick<
  TemplateSubmission,
  'parameterFormat' | 'body' | 'samples' | 'buttons'
>;

export interface TemplateSubmissionResult {
  providerTemplateId: string;
  status: TemplateReviewStatus;
  category: TemplateCategory;
}

export const TEMPLATE_VARIABLE_KEYS = [
  'customer',
  'store',
  'order',
  'total',
] as const satisfies readonly TemplateVariableKey[];
