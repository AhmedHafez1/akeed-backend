import { of } from 'rxjs';
import { WhatsAppService } from './whatsapp.service';

/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

describe('WhatsAppService', () => {
  function createService() {
    const httpService = {
      post: jest.fn().mockReturnValue(
        of({
          data: {
            messages: [{ id: 'wamid-1' }],
          },
        }),
      ),
    };

    const configService = {
      get: jest.fn((key: string) => {
        if (key === 'WA_ACCESS_TOKEN') return 'token-123';
        if (key === 'WA_PHONE_NUMBER_ID') return 'phone-id-123';
        return undefined;
      }),
    };

    const service = new WhatsAppService(
      httpService as any,
      configService as any,
    );

    return { service, httpService };
  }

  it('sends selected EN professional template with four body parameters', async () => {
    const { service, httpService } = createService();

    await service.sendVerificationTemplate({
      to: '+15551234567',
      customerName: 'John',
      storeName: 'Akeed Home',
      orderNumber: 'ORD-1001',
      totalPrice: '250 SAR',
      verificationId: 'ver-1',
      preferredLanguage: 'en',
      templateSelection: {
        en: 'professional',
      },
    });

    expect(httpService.post).toHaveBeenCalledTimes(1);
    const payload = httpService.post.mock.calls[0][1] as {
      template: {
        name: string;
        language: { code: string };
        components: Array<{
          parameters: Array<{
            type: 'text';
            parameter_name?: string;
            text: string;
          }>;
        }>;
      };
    };

    expect(payload.template.name).toBe('_akeed_cod_verification_professional');
    expect(payload.template.language.code).toBe('en');
    expect(payload.template.components[0].parameters).toEqual([
      {
        type: 'text',
        parameter_name: 'customer',
        text: 'John',
      },
      {
        type: 'text',
        parameter_name: 'store',
        text: 'Akeed Home',
      },
      {
        type: 'text',
        parameter_name: 'order',
        text: 'ORD-1001',
      },
      {
        type: 'text',
        parameter_name: 'total',
        text: '250 SAR',
      },
    ]);
  });

  it('keeps short template body parameters on order and total only', async () => {
    const { service, httpService } = createService();

    await service.sendVerificationTemplate({
      to: '+201001112223',
      customerName: 'Ahmed',
      storeName: 'Akeed Egypt',
      orderNumber: 'ORD-AR-22',
      totalPrice: '900 EGP',
      verificationId: 'ver-2',
      preferredLanguage: 'ar',
      templateSelection: {
        ar: 'short',
      },
    });

    const payload = httpService.post.mock.calls[0][1] as {
      template: {
        name: string;
        components: Array<{
          parameters: Array<{
            type: 'text';
            parameter_name?: string;
            text: string;
          }>;
        }>;
      };
    };

    expect(payload.template.name).toBe('akeed_cod_verification');
    expect(payload.template.components[0].parameters).toEqual([
      {
        type: 'text',
        text: 'ORD-AR-22',
      },
      {
        type: 'text',
        text: '900 EGP',
      },
    ]);
  });
});
