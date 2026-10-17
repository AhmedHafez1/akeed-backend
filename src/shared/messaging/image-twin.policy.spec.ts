import {
  imageTwinName,
  planImageTwin,
  providerIdentity,
  type ImageTwinParent,
  type ImageTwinSkipReason,
} from './image-twin.policy';
import { templateSampleValues } from './template-rendering';
import type { TemplateTextModel } from './template-text.types';

const NAMED: ImageTwinParent = {
  template: {
    key: 'cod_confirm.en.friendly',
    language: 'en',
    templateName: 'akeed_cod_verification_friendly',
    languageCode: 'en',
    parameterFormat: 'named',
    variables: [
      { key: 'customer', name: 'customer_name' },
      { key: 'order', name: 'order_number' },
      { key: 'total', name: 'order_total' },
    ],
  },
  category: 'utility',
  retired: false,
};

const NAMED_MODEL: TemplateTextModel = {
  format: 'named',
  body: [
    { text: 'Hi ' },
    { parameter: 'customer_name' },
    { text: ', order ' },
    { parameter: 'order_number' },
    { text: ' is ' },
    { parameter: 'order_total' },
    { text: '. Again: ' },
    { parameter: 'order_number' },
  ],
  footer: [{ text: 'Akeed' }],
  buttons: [
    { kind: 'quick_reply', text: 'Confirm' },
    { kind: 'quick_reply', text: 'Cancel' },
  ],
};

const EMPTY = {
  twinParentKeys: new Set<string>(),
  providerIdentities: new Set<string>(),
};

describe('planImageTwin', () => {
  it('copies body, footer and buttons, with samples in first-use order', () => {
    const plan = planImageTwin(NAMED, NAMED_MODEL, EMPTY);
    const samples = templateSampleValues('en');
    expect(plan).toEqual({
      kind: 'create',
      submission: {
        templateName: 'akeed_cod_verification_friendly_logo',
        languageCode: 'en',
        category: 'utility',
        parameterFormat: 'named',
        body: NAMED_MODEL.body,
        footer: NAMED_MODEL.footer,
        samples: [
          { parameter: 'customer_name', sample: samples.customer },
          { parameter: 'order_number', sample: samples.order },
          { parameter: 'order_total', sample: samples.total },
        ],
        buttons: [
          { kind: 'quick_reply', text: 'Confirm' },
          { kind: 'quick_reply', text: 'Cancel' },
        ],
      },
    });
  });

  it('maps positional parameters through the registry order (ar_EG)', () => {
    const parent: ImageTwinParent = {
      template: {
        key: 'cod_confirm.ar.direct_eg',
        language: 'ar',
        templateName: 'akeed_cod_verification_direct_eg',
        languageCode: 'ar_EG',
        parameterFormat: 'positional',
        variables: [{ key: 'store' }, { key: 'customer' }],
      },
      category: 'utility',
      retired: false,
    };
    const model: TemplateTextModel = {
      format: 'positional',
      body: [{ parameter: '2' }, { text: ' - ' }, { parameter: '1' }],
      buttons: [{ kind: 'quick_reply', text: 'تأكيد' }],
    };
    const plan = planImageTwin(parent, model, EMPTY);
    const samples = templateSampleValues('ar');
    expect(plan.kind).toBe('create');
    if (plan.kind !== 'create') return;
    expect(plan.submission.languageCode).toBe('ar_EG');
    expect(plan.submission.samples).toEqual([
      { parameter: '2', sample: samples.customer },
      { parameter: '1', sample: samples.store },
    ]);
    expect(plan.submission.footer).toBeUndefined();
  });

  it('adopts a twin the provider already holds, sending nothing', () => {
    const plan = planImageTwin(NAMED, NAMED_MODEL, {
      ...EMPTY,
      providerIdentities: new Set([
        providerIdentity(imageTwinName(NAMED.template.templateName), 'en'),
      ]),
    });
    expect(plan).toEqual({
      kind: 'adopt',
      templateName: 'akeed_cod_verification_friendly_logo',
    });
  });

  it('matches a provider language written with a dash', () => {
    const parent = {
      ...NAMED,
      template: { ...NAMED.template, languageCode: 'ar_EG' },
    };
    const plan = planImageTwin(parent, NAMED_MODEL, {
      ...EMPTY,
      providerIdentities: new Set([
        providerIdentity('akeed_cod_verification_friendly_logo', 'ar-EG'),
      ]),
    });
    expect(plan.kind).toBe('adopt');
  });

  it.each([
    [
      'has_twin',
      NAMED,
      NAMED_MODEL,
      { ...EMPTY, twinParentKeys: new Set([NAMED.template.key]) },
    ],
    ['retired', { ...NAMED, retired: true }, NAMED_MODEL, EMPTY],
    ['not_synced', NAMED, null, EMPTY],
    [
      'text_header',
      NAMED,
      { ...NAMED_MODEL, header: [{ text: 'Order' }] },
      EMPTY,
    ],
    [
      'non_quick_reply_button',
      NAMED,
      {
        ...NAMED_MODEL,
        buttons: [{ kind: 'other' as const, text: 'Track' }],
      },
      EMPTY,
    ],
    [
      'unknown_category',
      { ...NAMED, category: 'unknown' as const },
      NAMED_MODEL,
      EMPTY,
    ],
    ['unknown_category', { ...NAMED, category: null }, NAMED_MODEL, EMPTY],
    [
      'format_mismatch',
      NAMED,
      { ...NAMED_MODEL, format: 'positional' as const },
      EMPTY,
    ],
    [
      'format_mismatch',
      NAMED,
      { ...NAMED_MODEL, body: [{ parameter: 'not_registered' }] },
      EMPTY,
    ],
  ] as [
    ImageTwinSkipReason,
    ImageTwinParent,
    TemplateTextModel | null,
    typeof EMPTY,
  ][])('skips with %s', (reason, parent, model, context) => {
    expect(planImageTwin(parent, model, context)).toEqual({
      kind: 'skip',
      reason,
    });
  });

  it('creates a twin of a template without parameters', () => {
    const parent: ImageTwinParent = {
      ...NAMED,
      template: { ...NAMED.template, variables: [] },
    };
    const plan = planImageTwin(
      parent,
      { format: 'none', body: [{ text: 'Hello' }], buttons: [] },
      EMPTY,
    );
    expect(plan.kind === 'create' && plan.submission.samples).toEqual([]);
  });
});
