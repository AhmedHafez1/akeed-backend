import { planTemplateCopy } from '../../../shared/messaging/template-copy.policy';
import type { TemplateSubmission } from '../../../shared/messaging/template-draft.types';
import {
  TRACKING_LINK_SAMPLE_CODE,
  trackingLinkButton,
} from '../../../shared/messaging/tracking-link-button';
import {
  buildMetaCreateBody,
  buildMetaEditBody,
  buildMetaTemplateCopyBody,
} from './meta-template-components.builder';
import { mapComponents } from './meta-template.mapping';
import { describeMetaComponents } from './meta-template-text';

const SUBMISSION: TemplateSubmission = {
  templateName: 'akeed_shipping_shipped_default_v1',
  languageCode: 'en',
  category: 'utility',
  parameterFormat: 'named',
  body: [{ text: 'Hello ' }, { parameter: 'customer' }],
  samples: [{ parameter: 'customer', sample: 'Ahmed' }],
  buttons: [
    { kind: 'quick_reply', text: "I'll receive it" },
    { kind: 'quick_reply', text: "Won't be available" },
    { kind: 'quick_reply', text: 'Change address' },
    trackingLinkButton('Track order', 'https://getakeed.com'),
  ],
};

const EXPECTED_BUTTONS = {
  type: 'BUTTONS',
  buttons: [
    { type: 'QUICK_REPLY', text: "I'll receive it" },
    { type: 'QUICK_REPLY', text: "Won't be available" },
    { type: 'QUICK_REPLY', text: 'Change address' },
    {
      type: 'URL',
      text: 'Track order',
      url: 'https://getakeed.com/t/{{1}}',
      example: [`https://getakeed.com/t/${TRACKING_LINK_SAMPLE_CODE}`],
    },
  ],
};

describe('the Track order link button in Meta syntax', () => {
  it('creates the quick replies, then the link with its example', () => {
    const body = buildMetaCreateBody(SUBMISSION) as {
      components: unknown[];
    };
    expect(body.components.at(-1)).toEqual(EXPECTED_BUTTONS);
  });

  it('edits a named Shipped template with its format, named body and positional link', () => {
    expect(buildMetaEditBody(SUBMISSION)).toEqual({
      parameter_format: 'NAMED',
      components: [
        {
          type: 'BODY',
          text: 'Hello {{customer}}',
          example: {
            body_text_named_params: [
              { param_name: 'customer', example: 'Ahmed' },
            ],
          },
        },
        EXPECTED_BUTTONS,
      ],
    });
  });

  it('keeps the quick replies grouped even when given out of order', () => {
    const [link, ...replies] = [...SUBMISSION.buttons].reverse();
    const body = buildMetaCreateBody({
      ...SUBMISSION,
      buttons: [link, ...replies.reverse()],
    }) as { components: unknown[] };
    expect(body.components.at(-1)).toEqual(EXPECTED_BUTTONS);
  });

  it('reads the link back and copies it unchanged to a merchant account', () => {
    const snapshot = mapComponents([
      { type: 'BODY', text: 'Hello {{customer}}' },
      EXPECTED_BUTTONS,
    ]);
    const model = describeMetaComponents(snapshot);
    expect(model?.buttons.at(-1)).toEqual({
      kind: 'url',
      text: 'Track order',
      url: [{ text: 'https://getakeed.com/t/' }, { parameter: '1' }],
    });
    // The link's parameter is not a body parameter: the format stays named.
    expect(model?.format).toBe('named');

    const plan = planTemplateCopy(
      {
        language: 'en',
        languageCode: 'en',
        parameterFormat: 'named',
        variables: [{ key: 'customer', name: 'customer' }],
      },
      'utility',
      model,
      'akeed_shipping_shipped_default_v1',
    );
    expect(plan.kind).toBe('create');
    if (plan.kind !== 'create') return;
    const copy = buildMetaTemplateCopyBody(plan.submission) as {
      components: unknown[];
    };
    expect(copy.components.at(-1)).toEqual(EXPECTED_BUTTONS);
  });
});
