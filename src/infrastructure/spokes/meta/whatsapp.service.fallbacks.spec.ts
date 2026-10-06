import { of } from 'rxjs';
import { selectTemplateForSend } from '../../../shared/messaging/template-selector';
import { seededRegistryTemplates } from '../../../shared/messaging/testing/seeded-template-registry';
import { WhatsAppService } from './whatsapp.service';

/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */

/** US-08-07e at the Meta spoke: the words for a missing name. */
function setup() {
  const httpService = {
    post: jest.fn().mockReturnValue(of({ data: { messages: [{ id: 'w' }] } })),
  };
  const service = new WhatsAppService(
    httpService as never,
    {
      get: (key: string) =>
        ({ WA_ACCESS_TOKEN: 'token', WA_PHONE_NUMBER_ID: 'phone' })[key],
    } as never,
  );
  return { service, httpService };
}

function template(language: 'ar' | 'en') {
  const selection = selectTemplateForSend(seededRegistryTemplates(), {
    preferredLanguage: language,
    phoneNumber: '+966501234567',
  });
  if (!selection.template) throw new Error('no template');
  return selection.template;
}

function bodyValues(httpService: { post: jest.Mock }): Record<string, string> {
  const payload = httpService.post.mock.calls[0][1];
  const body = payload.template.components[0].parameters as Array<{
    parameter_name: string;
    text: string;
  }>;
  return Object.fromEntries(
    body.map((parameter) => [parameter.parameter_name, parameter.text]),
  );
}

const base = {
  to: '+966501234567',
  orderNumber: '1117',
  totalPrice: '1250.00 SAR',
  verificationId: 'ver-1',
};

describe('WhatsAppService fallbacks (US-08-07e)', () => {
  it.each([
    ['ar', 'عميلنا العزيز', 'متجرنا'],
    ['en', 'there', 'our store'],
  ] as const)(
    'uses the given %s words for a missing name, never Akeed',
    async (language, customer, store) => {
      const { service, httpService } = setup();
      await service.sendVerificationTemplate({
        ...base,
        customerName: ' ',
        storeName: null,
        template: template(language),
        fallbacks: { customer, store },
      });
      expect(bodyValues(httpService)).toMatchObject({ customer, store });
      expect(JSON.stringify(httpService.post.mock.calls[0][1])).not.toContain(
        'Akeed',
      );
    },
  );

  it('keeps a name that is present, whatever the fallback', async () => {
    const { service, httpService } = setup();
    await service.sendVerificationTemplate({
      ...base,
      customerName: 'Sara',
      storeName: 'Nour',
      template: template('en'),
      fallbacks: { customer: 'there', store: 'our store' },
    });
    expect(bodyValues(httpService)).toMatchObject({
      customer: 'Sara',
      store: 'Nour',
    });
  });

  it('without fallbacks, sends the old words exactly as before', async () => {
    const { service, httpService } = setup();
    await service.sendVerificationTemplate({
      ...base,
      customerName: null,
      storeName: '',
      template: template('en'),
    });
    expect(bodyValues(httpService)).toMatchObject({
      customer: 'Customer',
      store: 'Akeed Store',
    });
  });
});
