import {
  resolveEntitlement,
  type EntitlementSource,
} from '../../../shared/billing/entitlement';
import { of } from 'rxjs';
import { WhatsAppService } from './whatsapp.service';
import { VerificationSendService } from '../../../modules/verification-core/verification-send.service';

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

    return { service, httpService, configService };
  }

  it.each(['sendInitial', 'sendFollowUp'] as const)(
    'uses the actual global sender and selected template through %s',
    async (method) => {
      const {
        service: messaging,
        httpService,
        configService,
      } = createService();
      const verification = {
        orgId: 'org-1',
        id: 'ver-1',
        orderId: 'order-1',
        status: method === 'sendInitial' ? 'pending' : 'sent',
      };
      const integration = {
        id: 'int-1',
        orgId: 'org-1',
        isActive: true,
        platformType: 'shopify',
        billingStatus: 'active',
        storeName: 'Synthetic Store',
        defaultLanguage: 'en',
        codTemplateEnVariant: 'professional',
      };
      const verifications = {
        findById: jest.fn().mockResolvedValue(verification),
        updateStatus: jest.fn(),
      };
      const orders = {
        findById: jest.fn().mockResolvedValue({
          orgId: 'org-1',
          integrationId: 'int-1',
          externalOrderId: '12345',
          customerPhone: '+14155552671',
          customerName: 'Synthetic Customer',
          totalPrice: '123.40',
          currency: 'USD',
          integration,
        }),
      };
      const entitlement = {
        evaluateAccess: (source: EntitlementSource) =>
          resolveEntitlement(source, source),
        reserveVerificationSlot: jest
          .fn()
          .mockResolvedValue({ allowed: true, periodStart: '2026-05-01' }),
        releaseVerificationSlot: jest.fn(),
      };
      const sender = new VerificationSendService(
        verifications as never,
        orders as never,
        entitlement as never,
        {
          claim: jest.fn().mockResolvedValue({
            outcome: 'claimed',
            dispatch: { id: 'dispatch-1' },
          }),
          markAccepted: jest.fn(),
          markOutcomeUnknown: jest.fn(),
        } as never,
        messaging,
      );
      await expect(sender[method]('ver-1')).resolves.toMatchObject({
        status: 'sent',
        waMessageId: 'wamid-1',
      });
      expect(configService.get).toHaveBeenNthCalledWith(1, 'WA_ACCESS_TOKEN');
      expect(configService.get).toHaveBeenNthCalledWith(
        2,
        'WA_PHONE_NUMBER_ID',
      );
      expect(httpService.post).toHaveBeenCalledWith(
        'https://graph.facebook.com/v24.0/phone-id-123/messages',
        expect.objectContaining({
          to: '+14155552671',
          type: 'template',
          template: expect.objectContaining({
            name: '_akeed_cod_verification_professional',
            language: { code: 'en' },
            components: expect.arrayContaining([
              expect.objectContaining({
                type: 'body',
                parameters: [
                  {
                    type: 'text',
                    parameter_name: 'customer',
                    text: 'Synthetic Customer',
                  },
                  {
                    type: 'text',
                    parameter_name: 'store',
                    text: 'Synthetic Store',
                  },
                  { type: 'text', parameter_name: 'order', text: '12345' },
                  { type: 'text', parameter_name: 'total', text: '123.40 USD' },
                ],
              }),
              expect.objectContaining({
                type: 'button',
                parameters: [{ type: 'payload', payload: 'confirm_ver-1' }],
              }),
              expect.objectContaining({
                type: 'button',
                parameters: [{ type: 'payload', payload: 'cancel_ver-1' }],
              }),
            ]) as unknown,
          }) as unknown,
        }),
        {
          headers: {
            Authorization: 'Bearer token-123',
            'Content-Type': 'application/json',
          },
        },
      );
      expect(verifications.updateStatus).not.toHaveBeenCalled();
    },
  );

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
