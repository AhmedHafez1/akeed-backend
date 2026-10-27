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

function store(
  platformType: string,
  billingPlanId: string | null,
  logoHeaderEnabled = true,
) {
  return {
    platformType,
    billingPlanId,
    logoHeaderEnabled,
    logoBannerUrl: BANNER,
  } as never;
}

describe('VerificationSendService logo header', () => {
  it.each([
    ['shopify', 'starter'],
    ['shopify', 'basic'],
    ['shopify', 'pro'],
    ['shopify', 'business'],
    ['standalone', 'starter'],
    ['woocommerce', null],
  ])(
    'a %s store on %s with a banner and a twin sends the banner',
    async (platformType, billingPlanId) => {
      const template = selected();
      const service = serviceWithTwinOf(template);

      const result = await service['withLogoHeader'](
        template,
        store(platformType, billingPlanId),
      );

      expect(result.imageHeader).toBeTruthy();
    },
  );

  it('sends the text template when staff switch the store off', async () => {
    const template = selected();
    const service = serviceWithTwinOf(template);

    const result = await service['withLogoHeader'](
      template,
      store('shopify', 'starter', false),
    );

    expect(result.imageHeader).toBeFalsy();
    expect(result).toBe(template);
  });
});
