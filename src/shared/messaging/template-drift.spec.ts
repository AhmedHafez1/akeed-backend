import { compareTemplateDrift } from './template-drift';
import type { RegistryTemplate } from './template-registry.types';
import type { TemplateTextModel } from './template-text.types';

const SYNCED_AT = '2026-10-05T00:00:00.000Z';

function named(overrides: Partial<RegistryTemplate> = {}): RegistryTemplate {
  return {
    key: 'cod_confirm.en.friendly',
    purpose: 'cod_confirmation',
    language: 'en',
    style: 'friendly',
    templateName: 'akeed_cod_verification_friendly',
    languageCode: 'en',
    parameterFormat: 'named',
    variables: [
      { key: 'customer', name: 'customer' },
      { key: 'order', name: 'order_number' },
    ],
    preview: {
      greeting: 'Hi {{customer}}!',
      body: 'Your order #{{ order }} is ready.',
      totalLabel: '',
      ending: 'Please confirm.',
      confirmButton: 'Confirm',
      cancelButton: 'Cancel',
    },
    isActive: true,
    isDefault: true,
    reviewStatus: 'approved',
    category: 'utility',
    lastSyncedAt: SYNCED_AT,
    ...overrides,
  };
}

function model(overrides: Partial<TemplateTextModel> = {}): TemplateTextModel {
  return {
    format: 'named',
    body: [
      { text: 'Hi ' },
      { parameter: 'customer' },
      { text: '!\n\nYour order #' },
      { parameter: 'order_number' },
      { text: ' is ready.\n\nPlease confirm.' },
    ],
    buttons: [
      { kind: 'quick_reply', text: 'Confirm' },
      { kind: 'quick_reply', text: 'Cancel' },
    ],
    ...overrides,
  };
}

function compare(
  template: RegistryTemplate,
  provider: TemplateTextModel | null,
) {
  return compareTemplateDrift({
    template,
    reviewStatus: template.reviewStatus,
    model: provider,
  });
}

describe('compareTemplateDrift', () => {
  it('finds no drift when the provider holds what Akeed sends and previews', () => {
    expect(compare(named(), model())).toEqual({
      state: 'in_sync',
      differences: [],
    });
  });

  it('says nothing about an environment that has never synced', () => {
    expect(
      compare(named({ lastSyncedAt: null, reviewStatus: null }), null),
    ).toEqual({ state: 'not_synced', differences: [] });
  });

  it('reports a template the provider does not hold as missing', () => {
    expect(compare(named({ reviewStatus: 'missing' }), model())).toEqual({
      state: 'missing',
      differences: [],
    });
  });

  it('compares nothing when the provider text could not be read', () => {
    expect(compare(named(), null)).toEqual({
      state: 'unreadable',
      differences: [],
    });
  });

  it('reports a body that reads differently as a preview difference', () => {
    const drift = compare(
      named(),
      model({
        body: [
          { text: 'Hello ' },
          { parameter: 'customer' },
          { text: '! Your order #' },
          { parameter: 'order_number' },
          { text: ' is ready. Please confirm.' },
        ],
      }),
    );

    expect(drift).toEqual({
      state: 'drift',
      differences: [
        {
          kind: 'body',
          severity: 'preview',
          registered:
            'Hi {{customer}}! Your order #{{order}} is ready. Please confirm.',
          provider:
            'Hello {{customer}}! Your order #{{order}} is ready. Please confirm.',
        },
      ],
    });
  });

  it('counts a header or footer the preview lacks as a text difference', () => {
    const drift = compare(named(), model({ footer: [{ text: 'Akeed' }] }));

    expect(drift.differences.map(({ kind }) => kind)).toEqual(['body']);
  });

  it('reports a different button label as a preview difference', () => {
    const drift = compare(
      named(),
      model({
        buttons: [
          { kind: 'quick_reply', text: 'Confirm order' },
          { kind: 'quick_reply', text: 'Cancel' },
        ],
      }),
    );

    expect(drift.differences).toEqual([
      {
        kind: 'button_labels',
        severity: 'preview',
        registered: 'Confirm | Cancel',
        provider: 'Confirm order | Cancel',
      },
    ]);
  });

  it.each([
    ['one button', [{ kind: 'quick_reply' as const, text: 'Confirm' }]],
    [
      'a third button',
      [
        { kind: 'quick_reply' as const, text: 'Confirm' },
        { kind: 'quick_reply' as const, text: 'Cancel' },
        { kind: 'quick_reply' as const, text: 'Later' },
      ],
    ],
    [
      'a button that is not a quick reply',
      [
        { kind: 'quick_reply' as const, text: 'Confirm' },
        { kind: 'other' as const, text: 'Cancel' },
      ],
    ],
  ])('reports %s as a send difference', (_label, buttons) => {
    const drift = compare(named(), model({ buttons }));

    expect(drift.state).toBe('drift');
    expect(drift.differences).toEqual([
      expect.objectContaining({ kind: 'buttons', severity: 'send' }),
    ]);
  });

  it('reports a different parameter format as a send difference', () => {
    const drift = compare(
      named(),
      model({
        format: 'positional',
        body: [
          { text: 'Hi ' },
          { parameter: '1' },
          { text: '!\n\nYour order #' },
          { parameter: '2' },
          { text: ' is ready.\n\nPlease confirm.' },
        ],
      }),
    );

    expect(drift.differences.slice(0, 2)).toEqual([
      {
        kind: 'parameter_format',
        severity: 'send',
        registered: 'named',
        provider: 'positional',
      },
      {
        kind: 'variables',
        severity: 'send',
        registered: 'customer, order_number',
        provider: '1, 2',
      },
    ]);
  });

  it('reports a variable the provider lacks, or one Akeed does not send', () => {
    const lacking = compare(
      named(),
      model({ body: [{ text: 'Hi ' }, { parameter: 'customer' }] }),
    );
    const extra = compare(
      named(),
      model({
        body: [
          { text: 'Hi ' },
          { parameter: 'customer' },
          { text: '!\n\nYour order #' },
          { parameter: 'order_number' },
          { text: ' is ready.\n\nPlease confirm. ' },
          { parameter: 'eta' },
        ],
      }),
    );

    expect(lacking.differences[0]).toEqual({
      kind: 'variables',
      severity: 'send',
      registered: 'customer, order_number',
      provider: 'customer',
    });
    expect(extra.differences[0]).toMatchObject({
      kind: 'variables',
      provider: 'customer, eta, order_number',
    });
    expect(extra.differences[1]).toMatchObject({
      kind: 'body',
      provider: expect.stringContaining('{{?eta}}') as string,
    });
  });

  it('matches a positional template by position', () => {
    const template = named({
      parameterFormat: 'positional',
      variables: [{ key: 'order' }, { key: 'total' }],
      preview: {
        greeting: 'Hello',
        body: 'Order {{order}}',
        totalLabel: 'Total: {{total}}',
        ending: '',
        confirmButton: 'Confirm',
        cancelButton: 'Cancel',
      },
    });

    expect(
      compare(
        template,
        model({
          format: 'positional',
          body: [
            { text: 'Hello\nOrder ' },
            { parameter: '1' },
            { text: '\nTotal: ' },
            { parameter: '2' },
          ],
        }),
      ),
    ).toEqual({ state: 'in_sync', differences: [] });
  });
});
