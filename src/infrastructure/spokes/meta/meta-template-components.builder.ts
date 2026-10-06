import type {
  TemplateEditSubmission,
  TemplateSubmission,
} from '../../../shared/messaging/template-draft.types';
import type { TemplateCategory } from '../../../shared/messaging/template-provider.types';

/**
 * Meta's creation syntax for a template (record 3.3, 4.6.4, 4.7.5). This file
 * and `meta-template.mapping.ts` are the only places it is written.
 */

/** Record 4.5.1. `unknown` is never sent. */
const META_CATEGORY: Partial<Record<TemplateCategory, string>> = {
  utility: 'UTILITY',
  marketing: 'MARKETING',
  authentication: 'AUTHENTICATION',
};

/** Record 4.6.1. */
const META_PARAMETER_FORMAT = {
  named: 'NAMED',
  positional: 'POSITIONAL',
} as const;

/**
 * `BODY` with its example values, then `BUTTONS` with the quick replies in
 * send order. A named body carries `example.body_text_named_params`, a
 * positional one `example.body_text` as a nested list (record 4.6.4). A quick
 * reply has no payload at creation (4.7.5); it is set at send time.
 */
export function buildMetaComponents(
  submission: TemplateEditSubmission,
): unknown[] {
  const text = submission.body
    .map((segment) =>
      'text' in segment ? segment.text : `{{${segment.parameter}}}`,
    )
    .join('');
  const example =
    submission.samples.length === 0
      ? undefined
      : submission.parameterFormat === 'named'
        ? {
            body_text_named_params: submission.samples.map(
              ({ parameter, sample }) => ({
                param_name: parameter,
                example: sample,
              }),
            ),
          }
        : { body_text: [submission.samples.map(({ sample }) => sample)] };
  return [
    { type: 'BODY', text, ...(example ? { example } : {}) },
    {
      type: 'BUTTONS',
      buttons: submission.buttons.map((button) => ({
        type: 'QUICK_REPLY',
        text: button.text,
      })),
    },
  ];
}

/** The create request body (record 4.1.3). No time-to-live is set in E08. */
export function buildMetaCreateBody(
  submission: TemplateSubmission,
): Record<string, unknown> | null {
  const category = META_CATEGORY[submission.category];
  if (!category) return null;
  return {
    name: submission.templateName,
    language: submission.languageCode,
    category,
    parameter_format: META_PARAMETER_FORMAT[submission.parameterFormat],
    components: buildMetaComponents(submission),
  };
}

/** The edit request body (record 4.1.4, 4.3.4): every component, replaced. */
export function buildMetaEditBody(
  submission: TemplateEditSubmission,
): Record<string, unknown> {
  return { components: buildMetaComponents(submission) };
}
