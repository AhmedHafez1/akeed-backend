import { describeMetaComponents } from './meta-template-text';

describe('describeMetaComponents', () => {
  it('reads a named template into text and parameter segments', () => {
    expect(
      describeMetaComponents({
        body: 'Hi {{customer}}! Order #{{ order }} for {{total}}.',
        buttons: [
          { kind: 'quick_reply', text: 'Confirm' },
          { kind: 'quick_reply', text: 'Cancel' },
        ],
      }),
    ).toEqual({
      format: 'named',
      body: [
        { text: 'Hi ' },
        { parameter: 'customer' },
        { text: '! Order #' },
        { parameter: 'order' },
        { text: ' for ' },
        { parameter: 'total' },
        { text: '.' },
      ],
      buttons: [
        { kind: 'quick_reply', text: 'Confirm' },
        { kind: 'quick_reply', text: 'Cancel' },
      ],
    });
  });

  it('reads a positional template, with its header and footer', () => {
    expect(
      describeMetaComponents({
        header: 'Order {{1}}',
        body: 'تم استلام طلبك رقم {{1}}\nإجمالي السعر : {{2}}',
        footer: 'Akeed',
        buttons: [],
      }),
    ).toEqual({
      format: 'positional',
      header: [{ text: 'Order ' }, { parameter: '1' }],
      body: [
        { text: 'تم استلام طلبك رقم ' },
        { parameter: '1' },
        { text: '\nإجمالي السعر : ' },
        { parameter: '2' },
      ],
      footer: [{ text: 'Akeed' }],
      buttons: [],
    });
  });

  it('calls a template without parameters neither named nor positional', () => {
    expect(
      describeMetaComponents({
        body: 'Hello { not a parameter }',
        buttons: [],
      }),
    ).toEqual({
      format: 'none',
      body: [{ text: 'Hello { not a parameter }' }],
      buttons: [],
    });
  });

  it('gives nothing for a missing or unreadable snapshot', () => {
    expect(describeMetaComponents(null)).toBeNull();
    expect(describeMetaComponents({ unknown: true })).toBeNull();
  });
});
