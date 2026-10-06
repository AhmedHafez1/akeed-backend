import type {
  TemplateDraftContent,
  TemplateDraftIssue,
  TemplateDraftVariable,
} from './template-draft.types';
import {
  TEMPLATE_BODY_MAX_LENGTH,
  buildDraftKey,
  buildTemplateName,
  deriveDraftVariables,
  draftIdentity,
  toTemplateSubmission,
  validateBody,
  validateButtons,
  validateCategory,
  validateLanguageCode,
  validateName,
  validateParameterRatio,
  validateSamples,
  validateTemplateDraft,
  validateVariables,
} from './template-draft.validation';

const BODY = [
  'Hello {{customer}}, thank you for ordering from {{store}}.',
  'Your cash on delivery order {{order}} comes to {{total}} in all.',
  'Please confirm it so we can ship it to you.',
].join('\n');

function draft(
  overrides: Partial<TemplateDraftContent> = {},
): TemplateDraftContent {
  return {
    purpose: 'cod_confirmation',
    language: 'en',
    style: 'warm',
    version: 1,
    templateName: 'akeed_cod_confirm_warm_v1',
    languageCode: 'en',
    parameterFormat: 'named',
    category: 'utility',
    body: BODY,
    confirmLabel: 'Confirm order',
    cancelLabel: 'Cancel order',
    samples: {
      customer: 'Ahmed',
      store: 'Akeed Store',
      order: 'TEST-1',
      total: '250.00 USD',
    },
    ...overrides,
  };
}

const rules = (issues: TemplateDraftIssue[]) =>
  issues.map((issue) => issue.rule).sort();

const none = new Set<string>();

describe('template draft validation (US-08-06 criterion 3)', () => {
  it('passes a complete draft with no issue at all', () => {
    expect(validateTemplateDraft(draft(), { takenIdentities: none })).toEqual({
      issues: [],
      valid: true,
      variables: [
        { key: 'customer', parameter: 'customer', sample: 'Ahmed' },
        { key: 'store', parameter: 'store', sample: 'Akeed Store' },
        { key: 'order', parameter: 'order', sample: 'TEST-1' },
        { key: 'total', parameter: 'total', sample: '250.00 USD' },
      ],
    });
  });

  it('names the field, the rule and the record finding of each failure', () => {
    const result = validateTemplateDraft(
      draft({ confirmLabel: 'x'.repeat(26), languageCode: 'ar_SA' }),
      { takenIdentities: none },
    );

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([
      {
        field: 'language_code',
        rule: 'language_code_unsupported',
        finding: '4.6.10',
        severity: 'error',
      },
      {
        field: 'confirm_label',
        rule: 'button_label_too_long',
        finding: '4.7.2',
        severity: 'error',
      },
    ]);
  });

  describe('name (record 4.4.1, 4.4.3, decision 1)', () => {
    it('builds akeed_<purpose>_<style>_v<n> and the registry key', () => {
      expect(buildTemplateName('cod_confirmation', 'egyptian', 2)).toBe(
        'akeed_cod_confirm_egyptian_v2',
      );
      expect(buildDraftKey('cod_confirmation', 'ar', 'egyptian', 2)).toBe(
        'cod_confirm.ar.egyptian_v2',
      );
    });

    it('names a reminder akeed_cod_reminder_<style>_v<n> (US-08-07a)', () => {
      expect(buildTemplateName('cod_reminder', 'gulf', 1)).toBe(
        'akeed_cod_reminder_gulf_v1',
      );
      expect(buildDraftKey('cod_reminder', 'ar', 'gulf', 1)).toBe(
        'cod_reminder.ar.gulf_v1',
      );
    });

    it('accepts the generated name', () => {
      expect(validateName(draft(), none)).toEqual([]);
    });

    it.each([
      ['an uppercase letter', 'Akeed_cod_confirm_warm_v1'],
      ['a dash', 'akeed-cod-confirm-warm-v1'],
      ['more than 512 characters', `akeed_${'a'.repeat(512)}`],
    ])('4.4.1: refuses a name with %s', (_case, templateName) => {
      expect(rules(validateName(draft({ templateName }), none))).toContain(
        'name_format',
      );
    });

    it('refuses a name that does not follow the convention', () => {
      expect(
        rules(validateName(draft({ templateName: 'akeed_cod_warm' }), none)),
      ).toEqual(['name_convention']);
    });

    it.each(['Warm', 'warm-style', '1warm', 'warm_v2', 'w'.repeat(25), ''])(
      'refuses the style %p',
      (style) => {
        expect(
          rules(
            validateName(
              draft({
                style,
                templateName: buildTemplateName('cod_confirmation', style, 1),
              }),
              none,
            ),
          ),
        ).toContain('style_format');
      },
    );

    it('4.4.3: refuses a name and language another template has', () => {
      const taken = new Set([draftIdentity('akeed_cod_confirm_warm_v1', 'en')]);

      expect(rules(validateName(draft(), taken))).toEqual(['name_taken']);
      // The same name in another language is its own template.
      expect(validateName(draft({ languageCode: 'en_US' }), taken)).toEqual([]);
    });
  });

  describe('language code (record 4.6.10, 4.6.13)', () => {
    it.each([
      ['ar', 'ar'],
      ['ar', 'ar_EG'],
      ['en', 'en'],
      ['en', 'en_GB'],
    ] as const)('accepts %s / %s', (language, code) => {
      expect(validateLanguageCode(language, code)).toEqual([]);
    });

    it.each([
      ['ar', 'ar_SA'],
      ['ar', 'en'],
      ['en', 'en-US'],
      ['en', ''],
    ] as const)('refuses %s / %p', (language, code) => {
      expect(rules(validateLanguageCode(language, code))).toEqual([
        'language_code_unsupported',
      ]);
    });
  });

  describe('category (record 4.5.1)', () => {
    it('accepts the category the purpose is registered under', () => {
      expect(validateCategory('cod_confirmation', 'utility')).toEqual([]);
    });

    it('refuses any other category', () => {
      expect(rules(validateCategory('cod_confirmation', 'marketing'))).toEqual([
        'category_not_allowed',
      ]);
    });
  });

  describe('body (record 4.6.7, 4.6.8, decision 5)', () => {
    it('accepts a body of exactly the limit', () => {
      const text = `Hello ${'a'.repeat(TEMPLATE_BODY_MAX_LENGTH - 6)}`;
      expect(text).toHaveLength(TEMPLATE_BODY_MAX_LENGTH);
      expect(validateBody(text)).toEqual([]);
    });

    it('4.6.7: refuses a body over 1024 characters', () => {
      expect(
        rules(validateBody(`Hello ${'a'.repeat(TEMPLATE_BODY_MAX_LENGTH)}`)),
      ).toEqual(['body_too_long']);
    });

    it('refuses an empty body', () => {
      expect(rules(validateBody('  \n '))).toEqual(['body_required']);
    });

    it('decision 5: refuses a variable outside customer, store, order, total', () => {
      expect(
        rules(validateBody('Your items {{items}} are ready today')),
      ).toEqual(['variable_unknown']);
    });

    it.each(['Hello {{customer} now', 'Hello {customer}} now', 'Hello { now'])(
      '4.6.8: refuses mismatched braces in %p',
      (body) => {
        expect(rules(validateBody(body))).toContain('braces_mismatched');
      },
    );

    it.each([
      '{{customer}} your order is ready',
      'Your order is ready {{order}}',
      '  {{order}} is ready now',
    ])(
      '4.6.8: refuses a parameter that starts or ends the body (%p)',
      (body) => {
        expect(rules(validateBody(body))).toEqual(['parameter_at_edge']);
      },
    );
  });

  describe('parameter ratio (record 4.6.14)', () => {
    it('is silent at one parameter per three words', () => {
      expect(validateParameterRatio('Hello {{customer}} and welcome')).toEqual(
        [],
      );
    });

    it('warns past one parameter per three words, without blocking', () => {
      const issues = validateParameterRatio('Hi {{customer}} {{store}} now');

      expect(issues).toEqual([
        {
          field: 'body',
          rule: 'parameter_ratio',
          finding: '4.6.14',
          severity: 'warning',
        },
      ]);
      expect(
        validateTemplateDraft(
          draft({
            body: 'Hi {{customer}} {{store}} now',
            samples: { customer: 'A', store: 'B' },
          }),
          { takenIdentities: none },
        ).valid,
      ).toBe(true);
    });
  });

  describe('parameters and the mapping (record 4.6.2, 4.6.3)', () => {
    const named: TemplateDraftVariable[] = deriveDraftVariables(
      BODY,
      'named',
      draft().samples,
    );

    it('maps each variable to its own name, or its first-use position', () => {
      expect(named.map((variable) => variable.parameter)).toEqual([
        'customer',
        'store',
        'order',
        'total',
      ]);
      expect(
        deriveDraftVariables(
          'Order {{order}} for {{total}}, again {{order}} thanks',
          'positional',
          {},
        ),
      ).toEqual([
        { key: 'order', parameter: '1', sample: '' },
        { key: 'total', parameter: '2', sample: '' },
      ]);
    });

    it('accepts the derived mapping in both formats', () => {
      expect(validateVariables(BODY, 'named', named)).toEqual([]);
      expect(
        validateVariables(
          BODY,
          'positional',
          deriveDraftVariables(BODY, 'positional', {}),
        ),
      ).toEqual([]);
    });

    it.each([
      ['an uppercase letter', 'Customer'],
      ['a digit', 'customer1'],
      ['a name used twice', 'store'],
    ])('4.6.2: refuses a named parameter with %s', (_case, parameter) => {
      expect(
        rules(
          validateVariables(BODY, 'named', [
            { ...named[0], parameter },
            ...named.slice(1),
          ]),
        ),
      ).toEqual(['parameter_name_format']);
    });

    it.each([
      ['start at 2', ['2', '3', '4', '5']],
      ['skip a number', ['1', '2', '4', '5']],
      ['repeat a number', ['1', '1', '2', '3']],
    ])('4.6.3: refuses positions that %s', (_case, positions) => {
      expect(
        rules(
          validateVariables(
            BODY,
            'positional',
            named.map((variable, index) => ({
              ...variable,
              parameter: positions[index],
            })),
          ),
        ),
      ).toEqual(['parameter_numbering']);
    });

    it('refuses a mapping that misses a variable of the body', () => {
      expect(rules(validateVariables(BODY, 'named', named.slice(1)))).toEqual([
        'mapping_incomplete',
      ]);
    });

    it('refuses a mapping for a variable the body does not use', () => {
      expect(
        rules(
          validateVariables(
            'Hello there, {{customer}} and all',
            'named',
            named,
          ),
        ),
      ).toEqual(['mapping_incomplete']);
    });
  });

  describe('samples (record 4.6.4, 4.6.12)', () => {
    const variables = deriveDraftVariables(BODY, 'named', draft().samples);

    it('accepts one single-line sample per parameter', () => {
      expect(validateSamples(BODY, variables)).toEqual([]);
    });

    it('4.6.4: refuses a parameter without a sample', () => {
      expect(
        rules(
          validateSamples(BODY, [
            { ...variables[0], sample: ' ' },
            ...variables.slice(1),
          ]),
        ),
      ).toEqual(['sample_missing']);
    });

    it('4.6.12: refuses a sample with a line break', () => {
      expect(
        rules(
          validateSamples(BODY, [
            { ...variables[0], sample: 'Ahmed\nAli' },
            ...variables.slice(1),
          ]),
        ),
      ).toEqual(['sample_multiline']);
    });

    it('4.6.12: refuses samples that fill the body to the limit', () => {
      expect(
        rules(
          validateSamples(BODY, [
            { ...variables[0], sample: 'a'.repeat(TEMPLATE_BODY_MAX_LENGTH) },
            ...variables.slice(1),
          ]),
        ),
      ).toEqual(['filled_body_too_long']);
    });
  });

  describe('buttons (record 4.7.1, 4.7.2, 4.7.6, 4.7.8)', () => {
    const labels = {
      confirmLabel: 'Confirm order',
      cancelLabel: 'Cancel order',
    };
    const buttons = toTemplateSubmission(draft()).buttons;

    it('builds exactly Confirm then Cancel for a COD confirmation', () => {
      expect(buttons).toEqual([
        { kind: 'quick_reply', text: 'Confirm order' },
        { kind: 'quick_reply', text: 'Cancel order' },
      ]);
      expect(validateButtons('cod_confirmation', buttons, labels)).toEqual([]);
    });

    it('4.7.6: refuses the cancel button first', () => {
      expect(
        rules(
          validateButtons('cod_confirmation', [...buttons].reverse(), labels),
        ),
      ).toEqual(['button_order']);
    });

    it.each([
      ['one button', 1],
      ['a third button', 3],
    ])('4.7.8: refuses %s', (_case, count) => {
      const many = Array.from({ length: count }, (_, index) => ({
        kind: 'quick_reply' as const,
        text: index === 0 ? labels.confirmLabel : labels.cancelLabel,
      }));

      expect(rules(validateButtons('cod_confirmation', many, labels))).toEqual([
        'button_count',
      ]);
    });

    it('4.7.2: accepts a 25-character label and refuses a 26-character one', () => {
      const at = { ...labels, cancelLabel: 'c'.repeat(25) };
      const over = { ...labels, cancelLabel: 'c'.repeat(26) };
      const of = (value: typeof labels) =>
        toTemplateSubmission(draft(value)).buttons;

      expect(validateButtons('cod_confirmation', of(at), at)).toEqual([]);
      expect(
        rules(validateButtons('cod_confirmation', of(over), over)),
      ).toEqual(['button_label_too_long']);
    });

    it('refuses a missing label, and two labels that read the same', () => {
      const empty = { ...labels, confirmLabel: '' };
      const same = { confirmLabel: 'OK', cancelLabel: 'OK' };
      const of = (value: typeof labels) =>
        toTemplateSubmission(draft(value)).buttons;

      expect(
        rules(validateButtons('cod_confirmation', of(empty), empty)),
      ).toEqual(['button_label_required']);
      expect(
        rules(validateButtons('cod_confirmation', of(same), same)),
      ).toEqual(['button_labels_identical']);
    });
  });

  it('hands the provider port segments and samples, never placeholder text', () => {
    expect(
      toTemplateSubmission(
        draft({
          parameterFormat: 'positional',
          body: 'Order {{order}} comes to {{total}} in all.',
          samples: { order: 'TEST-1', total: '250.00 USD' },
        }),
      ),
    ).toEqual({
      templateName: 'akeed_cod_confirm_warm_v1',
      languageCode: 'en',
      category: 'utility',
      parameterFormat: 'positional',
      body: [
        { text: 'Order ' },
        { parameter: '1' },
        { text: ' comes to ' },
        { parameter: '2' },
        { text: ' in all.' },
      ],
      samples: [
        { parameter: '1', sample: 'TEST-1' },
        { parameter: '2', sample: '250.00 USD' },
      ],
      buttons: [
        { kind: 'quick_reply', text: 'Confirm order' },
        { kind: 'quick_reply', text: 'Cancel order' },
      ],
    });
  });
});
