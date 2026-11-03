import { planTemplateCopy } from '../../../shared/messaging/template-copy.policy';
import { buildMetaTemplateCopyBody } from './meta-template-components.builder';
import { describeMetaComponents } from './meta-template-text';

const TEMPLATE = {
  language: 'en' as const,
  languageCode: 'en',
  parameterFormat: 'named' as const,
  variables: [
    { key: 'customer' as const, name: 'customer' },
    { key: 'order' as const, name: 'order' },
  ],
};

describe('buildMetaTemplateCopyBody', () => {
  it('copies a synced template into the create syntax with sample values and no header', () => {
    const plan = planTemplateCopy(
      TEMPLATE,
      'utility',
      describeMetaComponents({
        body: 'Hello {{customer}}, confirm order {{order}}?',
        footer: 'Akeed',
        buttons: [
          { kind: 'quick_reply', text: 'Confirm' },
          { kind: 'quick_reply', text: 'Cancel' },
        ],
      }),
      'akeed_cod_verification_friendly',
    );
    expect(plan.kind).toBe('create');
    if (plan.kind !== 'create') return;
    const body = buildMetaTemplateCopyBody(plan.submission)!;
    expect(body).toMatchObject({
      name: 'akeed_cod_verification_friendly',
      language: 'en',
      category: 'UTILITY',
      parameter_format: 'NAMED',
    });
    const components = body.components as { type: string }[];
    expect(components.map((c) => c.type)).toEqual([
      'BODY',
      'FOOTER',
      'BUTTONS',
    ]);
    expect(components[0]).toMatchObject({
      text: 'Hello {{customer}}, confirm order {{order}}?',
      example: {
        body_text_named_params: [
          { param_name: 'customer', example: expect.any(String) as string },
          { param_name: 'order', example: expect.any(String) as string },
        ],
      },
    });
  });

  it('asks for no category it cannot name', () => {
    expect(
      buildMetaTemplateCopyBody({
        templateName: 'x',
        languageCode: 'en',
        category: 'unknown',
        parameterFormat: 'none',
        body: [{ text: 'Hi' }],
        samples: [],
        buttons: [],
      }),
    ).toBeNull();
  });
});
