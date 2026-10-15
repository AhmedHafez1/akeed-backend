import { applyLogoHeader, isHttpsUrl } from './logo-header.policy';
import { selectTemplateForSend } from './template-selector';
import { seededRegistryTemplates } from './testing/seeded-template-registry';
import type { ImageTwinTemplate } from './template-registry.types';

const BANNER = 'https://cdn.example.test/logos/abc-banner.jpg';

function selected() {
  const selection = selectTemplateForSend(seededRegistryTemplates(), {
    preferredLanguage: 'ar',
    phoneNumber: '+966501234567',
  });
  if (!selection.template) throw new Error('no template');
  return selection.template;
}

function twinOf(
  template: ReturnType<typeof selected>,
  overrides: Partial<ImageTwinTemplate> = {},
): ImageTwinTemplate {
  return {
    imageTwinOfKey: `cod_confirm.${template.variantKey}`,
    twinOf: {
      templateName: template.templateName,
      languageCode: template.languageCode,
    },
    templateName: `${template.templateName}_logo`,
    languageCode: template.languageCode,
    isActive: true,
    reviewStatus: 'approved',
    ...overrides,
  };
}

describe('applyLogoHeader', () => {
  it('sends the twin with the banner when the store may', () => {
    const template = selected();
    const result = applyLogoHeader(template, {
      enabled: true,
      bannerUrl: BANNER,
      twins: [twinOf(template)],
    });
    expect(result).toEqual({
      ...template,
      imageHeader: {
        templateName: `${template.templateName}_logo`,
        languageCode: template.languageCode,
        imageUrl: BANNER,
      },
    });
  });

  it.each([
    ['the switch is off', { enabled: false, bannerUrl: BANNER }],
    ['no banner is saved', { enabled: true, bannerUrl: null }],
    [
      'the banner is not https',
      { enabled: true, bannerUrl: 'http://x.test/b.jpg' },
    ],
  ])('keeps the text template when %s', (_label, context) => {
    const template = selected();
    expect(
      applyLogoHeader(template, { ...context, twins: [twinOf(template)] }),
    ).toBe(template);
  });

  it('keeps the text template when it has no twin', () => {
    const template = selected();
    const other = twinOf(template, {
      twinOf: { templateName: 'someone_else', languageCode: 'ar' },
    });
    expect(
      applyLogoHeader(template, {
        enabled: true,
        bannerUrl: BANNER,
        twins: [other],
      }),
    ).toBe(template);
  });

  it('never sends an inactive twin', () => {
    const template = selected();
    expect(
      applyLogoHeader(template, {
        enabled: true,
        bannerUrl: BANNER,
        twins: [twinOf(template, { isActive: false })],
      }),
    ).toBe(template);
  });

  it('holds back an unapproved twin under the guardrail only', () => {
    const template = selected();
    const twins = [twinOf(template, { reviewStatus: 'pending' })];
    expect(
      applyLogoHeader(template, {
        enabled: true,
        bannerUrl: BANNER,
        twins,
        guardrail: { enabled: true },
      }),
    ).toBe(template);
    expect(
      applyLogoHeader(template, { enabled: true, bannerUrl: BANNER, twins })
        .imageHeader,
    ).toBeDefined();
  });

  it('matches a reminder by its own name, not its first-send template', () => {
    const template = { ...selected(), templateName: 'cod_reminder_ar' };
    const firstSendTwin = twinOf(selected());
    const reminderTwin = twinOf(template, {
      templateName: 'cod_reminder_ar_logo',
    });
    const result = applyLogoHeader(template, {
      enabled: true,
      bannerUrl: BANNER,
      twins: [firstSendTwin, reminderTwin],
    });
    expect(result.imageHeader?.templateName).toBe('cod_reminder_ar_logo');
  });
});

describe('isHttpsUrl', () => {
  it.each([
    ['https://a.test/x.jpg', true],
    ['http://a.test/x.jpg', false],
    ['not a url', false],
    ['', false],
    [null, false],
  ])('%s -> %s', (value, expected) => {
    expect(isHttpsUrl(value)).toBe(expected);
  });
});
