import { selectTemplateForSend } from '../../shared/messaging/template-selector';
import { seededRegistryTemplates } from '../../shared/messaging/testing/seeded-template-registry';
import type { ImageTwinTemplate } from '../../shared/messaging/template-registry.types';
import { VerificationSendService } from './verification-send.service';

const BANNER = 'https://cdn.example.test/logos/abc-banner.jpg';

function selected() {
  const selection = selectTemplateForSend(seededRegistryTemplates(), {
    preferredLanguage: 'ar',
    phoneNumber: '+966501234567',
  });
  if (!selection.template) throw new Error('no template');
  return selection.template;
}

function serviceWithTwinOf(template: ReturnType<typeof selected>) {
  const twin: ImageTwinTemplate = {
    imageTwinOfKey: `cod_confirm.${template.variantKey}`,
    twinOf: {
      templateName: template.templateName,
      languageCode: template.languageCode,
    },
    templateName: `${template.templateName}_logo`,
    languageCode: template.languageCode,
    isActive: true,
    reviewStatus: 'approved',
  };
  return new VerificationSendService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {
      listImageTwins: jest.fn().mockResolvedValue([twin]),
      sendGuardrailEnabled: () => true,
    } as never,
  );
}

function store(platformType: string, billingPlanId: string | null) {
  return {
    platformType,
    billingPlanId,
    logoHeaderEnabled: true,
    logoBannerUrl: BANNER,
  } as never;
}

describe('VerificationSendService logo header plan gate', () => {
  it.each([
    ['shopify', 'pro', true],
    ['shopify', 'business', true],
    ['shopify', 'basic', false],
    ['shopify', 'starter', false],
    ['standalone', 'starter', true],
    ['woocommerce', null, true],
  ])(
    'a %s store on %s sends the banner: %s',
    async (platformType, billingPlanId, sendsBanner) => {
      const template = selected();
      const service = serviceWithTwinOf(template);

      const result = await service['withLogoHeader'](
        template,
        store(platformType, billingPlanId),
      );

      expect(Boolean(result.imageHeader)).toBe(sendsBanner);
    },
  );
});
