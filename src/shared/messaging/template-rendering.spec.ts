import { seededRegistryTemplates } from './testing/seeded-template-registry';
import {
  providerParameterOf,
  renderRegisteredPreview,
  renderTemplateMessage,
  templateSampleValues,
} from './template-rendering';
import type { TemplateTextModel } from './template-text.types';

const templates = seededRegistryTemplates();
const byKey = (key: string) => {
  const template = templates.find((entry) => entry.key === key);
  if (!template) throw new Error(`no seeded template ${key}`);
  return template;
};

const buttons: TemplateTextModel['buttons'] = [
  { kind: 'quick_reply', text: 'Confirm' },
  { kind: 'quick_reply', text: 'Cancel' },
];

describe('template rendering', () => {
  it('fills a named template with sample values, one paragraph per line', () => {
    const rendered = renderTemplateMessage(
      {
        format: 'named',
        body: [
          { text: 'Hi ' },
          { parameter: 'customer' },
          { text: '! 👋\n\nThank you for shopping with ' },
          { parameter: 'store' },
          { text: '. \n\nYour order #' },
          { parameter: 'order' },
          { text: ' for ' },
          { parameter: 'total' },
          { text: ' is ready.' },
        ],
        buttons,
      },
      byKey('cod_confirm.en.friendly'),
    );

    expect(rendered).toEqual({
      paragraphs: [
        'Hi Ahmed! 👋',
        'Thank you for shopping with Akeed Store.',
        'Your order #TEST-1 for 250.00 USD is ready.',
      ],
      buttons: [
        { label: 'Confirm', kind: 'quick_reply' },
        { label: 'Cancel', kind: 'quick_reply' },
      ],
      direction: 'ltr',
    });
  });

  it('fills a positional template by position, right to left for Arabic', () => {
    const template = byKey('cod_confirm.ar.short');

    const rendered = renderTemplateMessage(
      {
        format: 'positional',
        header: [{ text: 'أكيد' }],
        body: [
          { text: 'تم استلام طلبك رقم ' },
          { parameter: '1' },
          { text: '\nإجمالي السعر : ' },
          { parameter: '2' },
        ],
        footer: [{ text: 'شكرًا' }],
        buttons: [],
      },
      template,
    );

    expect([0, 1].map((index) => providerParameterOf(template, index))).toEqual(
      ['1', '2'],
    );
    expect(rendered).toEqual({
      paragraphs: [
        'أكيد',
        'تم استلام طلبك رقم TEST-1',
        'إجمالي السعر : 250.00 USD',
        'شكرًا',
      ],
      buttons: [],
      direction: 'rtl',
    });
  });

  it('shows a parameter the registry does not send as a marker, not a guess', () => {
    const rendered = renderTemplateMessage(
      {
        format: 'named',
        body: [{ text: 'Arrives ' }, { parameter: 'eta' }],
        buttons: [],
      },
      byKey('cod_confirm.en.friendly'),
    );

    expect(rendered.paragraphs).toEqual(['Arrives [eta]']);
  });

  it('renders the hand-kept preview with the same sample values', () => {
    const template = byKey('cod_confirm.en.short');

    expect(renderRegisteredPreview(template)).toEqual({
      paragraphs: [
        'Hello',
        'We have received your order #TEST-1 with Cash on Delivery.',
        'Total Price: 250.00 USD',
        'Please confirm your order.',
      ],
      buttons: [
        { label: 'Confirm', kind: 'quick_reply' },
        { label: 'Cancel', kind: 'quick_reply' },
      ],
      direction: 'ltr',
    });
    expect(
      renderRegisteredPreview(byKey('cod_confirm.ar.standard')),
    ).toMatchObject({ direction: 'rtl' });
  });

  it('uses an Arabic customer and store for an Arabic template', () => {
    expect(templateSampleValues('ar')).toEqual({
      customer: 'أحمد',
      store: 'متجر أكيد',
      order: 'TEST-1',
      total: '250.00 USD',
    });
  });
});
