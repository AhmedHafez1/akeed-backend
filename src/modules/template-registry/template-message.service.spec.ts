import { describeMetaComponents } from '../../infrastructure/spokes/meta/meta-template-text';
import { MESSAGE_IMPROVEMENT_SWITCHES_OFF } from '../../shared/config/whatsapp-template.config';
import { seededRegistryTemplates } from '../../shared/messaging/testing/seeded-template-registry';
import type { RegistryTemplate } from '../../shared/messaging/template-registry.types';
import { TemplateMessageService } from './template-message.service';

/** US-08-07g: the neutral message Settings and the onboarding test render. */
const catalog = { describeComponents: describeMetaComponents };

function service(snapshotPreview: boolean) {
  return new TemplateMessageService(
    catalog as never,
    {
      current: () => ({ ...MESSAGE_IMPROVEMENT_SWITCHES_OFF, snapshotPreview }),
    } as never,
  );
}

function seeded(key: string): RegistryTemplate {
  const template = seededRegistryTemplates().find((row) => row.key === key);
  if (!template) throw new Error(key);
  return template;
}

const egyptian: RegistryTemplate = {
  ...seeded('cod_confirm.ar.egyptian'),
  components: {
    body: 'أهلًا {{customer}}،\nطلبك رقم #{{order}} من {{store}} مستني تأكيدك.\n\nياريت تأكّد الطلب بقيمة {{total}} دلوقتي.',
    buttons: [
      { kind: 'quick_reply', text: 'تأكيد وشحن' },
      { kind: 'quick_reply', text: 'إلغاء الطلب' },
    ],
  },
};

describe('TemplateMessageService', () => {
  it('reads the synced provider text when the switch is on', () => {
    expect(service(true).linesFor(egyptian)).toEqual({
      lines: [
        [{ text: 'أهلًا ' }, { variable: 'customer' }, { text: '،' }],
        [
          { text: 'طلبك رقم #' },
          { variable: 'order' },
          { text: ' من ' },
          { variable: 'store' },
          { text: ' مستني تأكيدك.' },
        ],
        [
          { text: 'ياريت تأكّد الطلب بقيمة ' },
          { variable: 'total' },
          { text: ' دلوقتي.' },
        ],
      ],
      buttons: ['تأكيد وشحن', 'إلغاء الطلب'],
      direction: 'rtl',
      source: 'provider',
    });
  });

  it('reads a positional template by position', () => {
    const short: RegistryTemplate = {
      ...seeded('cod_confirm.en.short'),
      components: {
        body: 'We have received your order #{{1}}.\nTotal Price: {{2}}',
        buttons: [{ kind: 'quick_reply', text: 'Confirm' }],
      },
    };
    expect(service(true).linesFor(short)).toMatchObject({
      lines: [
        [
          { text: 'We have received your order #' },
          { variable: 'order' },
          { text: '.' },
        ],
        [{ text: 'Total Price: ' }, { variable: 'total' }],
      ],
      direction: 'ltr',
      source: 'provider',
    });
  });

  it('reads the stored preview with the switch off, or without a usable snapshot', () => {
    const registered = {
      lines: [
        [{ text: 'أهلًا ' }, { variable: 'customer' }, { text: '،' }],
        [
          { text: 'طلبك رقم #' },
          { variable: 'order' },
          { text: ' من ' },
          { variable: 'store' },
          { text: ' مستني تأكيدك.' },
        ],
        [{ text: 'إجمالي الطلب: ' }, { variable: 'total' }],
        [
          { text: 'ياريت تأكّد الطلب بقيمة ' },
          { variable: 'total' },
          { text: ' دلوقتي عشان نشحنهولك فورًا.' },
        ],
      ],
      buttons: ['تأكيد وشحن', 'إلغاء الطلب'],
      direction: 'rtl',
      source: 'registered',
    };
    expect(service(false).linesFor(egyptian)).toEqual(registered);
    expect(
      service(true).linesFor({ ...egyptian, components: { unknown: true } }),
    ).toEqual(registered);
    expect(service(true).linesFor({ ...egyptian, components: null })).toEqual(
      registered,
    );
    expect(new TemplateMessageService().linesFor(egyptian)).toEqual(registered);
  });

  it('drops empty preview blocks and keeps a placeholder the registry does not send', () => {
    const direct = seeded('cod_confirm.en.direct');
    expect(service(false).linesFor(direct).lines).toHaveLength(3);
    expect(
      service(true).linesFor({
        ...direct,
        components: { body: 'Hi {{nickname}}', buttons: [] },
      }).lines,
    ).toEqual([[{ text: 'Hi [nickname]' }]]);
  });
});
