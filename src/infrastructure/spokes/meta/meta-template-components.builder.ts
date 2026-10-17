import type {
  ImageTwinSubmission,
  TemplateEditSubmission,
  TemplateSubmission,
} from '../../../shared/messaging/template-draft.types';
import type { TemplateTextSegment } from '../../../shared/messaging/template-text.types';
import type { TemplateCategory } from '../../../shared/messaging/template-provider.types';

/**
 * Meta's creation syntax for a template. This file
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
 * positional one `example.body_text` as a nested list. A quick
 * reply has no payload at creation (4.7.5); it is set at send time.
 */
export function buildMetaComponents(
  submission: TemplateEditSubmission,
): unknown[] {
  return [
    buildBodyComponent(submission),
    {
      type: 'BUTTONS',
      buttons: submission.buttons.map((button) => ({
        type: 'QUICK_REPLY',
        text: button.text,
      })),
    },
  ];
}

/** Meta's placeholder syntax back into text: `{{name}}` or `{{1}}`. */
function toMetaText(segments: readonly TemplateTextSegment[]): string {
  return segments
    .map((segment) =>
      'text' in segment ? segment.text : `{{${segment.parameter}}}`,
    )
    .join('');
}

/** `BODY` with its example values; a body without parameters has none. */
function buildBodyComponent(submission: {
  body: readonly TemplateTextSegment[];
  samples: readonly { parameter: string; sample: string }[];
  parameterFormat: string;
}): Record<string, unknown> {
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
  return {
    type: 'BODY',
    text: toMetaText(submission.body),
    ...(example ? { example } : {}),
  };
}

/**
 * The create request body of an image twin: an `IMAGE` header reviewed with
 * the uploaded sample, then the parent's body, footer and quick replies as
 * they are. A named template keeps `parameter_format`; one without
 * parameters sends none.
 */
export function buildMetaImageTwinBody(
  submission: ImageTwinSubmission,
): Record<string, unknown> | null {
  const category = META_CATEGORY[submission.category];
  if (!category) return null;
  return {
    name: submission.templateName,
    language: submission.languageCode,
    category,
    ...(submission.parameterFormat === 'none'
      ? {}
      : {
          parameter_format: META_PARAMETER_FORMAT[submission.parameterFormat],
        }),
    components: [
      {
        type: 'HEADER',
        format: 'IMAGE',
        example: { header_handle: [submission.headerHandle] },
      },
      buildBodyComponent(submission),
      ...(submission.footer && submission.footer.length > 0
        ? [{ type: 'FOOTER', text: toMetaText(submission.footer) }]
        : []),
      {
        type: 'BUTTONS',
        buttons: submission.buttons.map((button) => ({
          type: 'QUICK_REPLY',
          text: button.text,
        })),
      },
    ],
  };
}

/** The create request body. No time-to-live is set. */
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

/** The edit request body: every component, replaced. */
export function buildMetaEditBody(
  submission: TemplateEditSubmission,
): Record<string, unknown> {
  return { components: buildMetaComponents(submission) };
}
