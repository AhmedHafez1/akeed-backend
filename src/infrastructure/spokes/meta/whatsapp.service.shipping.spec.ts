import { of } from 'rxjs';
import { WhatsAppService } from './whatsapp.service';
import type { SelectedCodTemplate } from '../../../shared/messaging/cod-template-selector';
import { shippingButtonPayloads } from '../../../shared/shipping/shipping-reply';

const VERIFICATION = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';

const SHIPPED: SelectedCodTemplate = {
  registryKey: 'shipping_shipped.en.default',
  variantKey: 'en.default',
  language: 'en',
  templateName: 'akeed_shipping_shipped_default_v1',
  languageCode: 'en',
  parameterFormat: 'named',
  variables: [
    { key: 'customer', name: 'customer' },
    { key: 'order', name: 'order' },
    { key: 'store', name: 'store' },
    { key: 'tracking', name: 'tracking' },
  ],
};

interface SentPayload {
  template: {
    name: string;
    components: {
      type: string;
      sub_type?: string;
      index?: number;
      parameters: {
        parameter_name?: string;
        text?: string;
        payload?: string;
      }[];
    }[];
  };
}

function createService() {
  const httpService = {
    post: jest
      .fn()
      .mockReturnValue(of({ data: { messages: [{ id: 'wamid-1' }] } })),
  };
  const configService = {
    get: jest.fn((key: string) =>
      key === 'WA_ACCESS_TOKEN'
        ? 'token-123'
        : key === 'WA_PHONE_NUMBER_ID'
          ? 'phone-id-123'
          : undefined,
    ),
  };
  return {
    service: new WhatsAppService(httpService as never, configService as never),
    httpService,
  };
}

describe('WhatsAppService: the Shipped message', () => {
  it('sends the tracking line and the three sh1 payloads in button order', async () => {
    const { service, httpService } = createService();
    await service.sendVerificationTemplate({
      to: '+12025550100',
      customerName: 'Sara',
      storeName: 'Akeed Store',
      orderNumber: '1001',
      totalPrice: '100',
      verificationId: VERIFICATION,
      template: SHIPPED,
      tracking: 'Tracking: 1Z999',
      buttonPayloads: shippingButtonPayloads(VERIFICATION),
    });
    const [, body] = httpService.post.mock.calls[0] as [string, SentPayload];
    expect(body.template.name).toBe('akeed_shipping_shipped_default_v1');
    const bodyComponent = body.template.components.find(
      (component) => component.type === 'body',
    );
    expect(bodyComponent?.parameters).toEqual([
      { type: 'text', parameter_name: 'customer', text: 'Sara' },
      { type: 'text', parameter_name: 'order', text: '1001' },
      { type: 'text', parameter_name: 'store', text: 'Akeed Store' },
      { type: 'text', parameter_name: 'tracking', text: 'Tracking: 1Z999' },
    ]);
    expect(
      body.template.components
        .filter((component) => component.type === 'button')
        .map((component) => [
          component.index,
          component.sub_type,
          component.parameters[0].payload,
        ]),
    ).toEqual([
      [0, 'quick_reply', `sh1|home|${VERIFICATION}`],
      [1, 'quick_reply', `sh1|reschedule|${VERIFICATION}`],
      [2, 'quick_reply', `sh1|address|${VERIFICATION}`],
    ]);
  });

  it('never sends an empty tracking parameter', async () => {
    const { service, httpService } = createService();
    await service.sendVerificationTemplate({
      to: '+12025550100',
      orderNumber: '1001',
      totalPrice: '100',
      verificationId: VERIFICATION,
      template: SHIPPED,
      buttonPayloads: shippingButtonPayloads(VERIFICATION),
    });
    const [, body] = httpService.post.mock.calls[0] as [string, SentPayload];
    const tracking = body.template.components
      .find((component) => component.type === 'body')
      ?.parameters.find((parameter) => parameter.parameter_name === 'tracking');
    expect(tracking?.text?.length).toBeGreaterThan(0);
  });
});
