import { WhatsAppWebhookService } from './whatsapp.webhook.service';
import type { WhatsAppWebhookPayloadDto } from './dto/whatsapp-webhook.dto';

/* eslint-disable @typescript-eslint/no-unsafe-argument */

const VERIFICATION_ID = '11111111-2222-4333-8444-555555555555';

function buttonMessage(payload: string): WhatsAppWebhookPayloadDto {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              messages: [
                {
                  id: 'wamid.customer-1',
                  from: '201012345678',
                  timestamp: '1700000000',
                  type: 'button',
                  button: { payload },
                  context: { id: 'wamid.sent-1' },
                },
              ],
            },
          },
        ],
      },
    ],
  } as WhatsAppWebhookPayloadDto;
}

function setup(outcome: 'applied' | 'rejected') {
  const adminLifecycles = {
    recordMessageStatus: jest.fn().mockResolvedValue(undefined),
  };
  const verificationHub = {
    finalizeVerification: jest.fn().mockResolvedValue(undefined),
  };
  const changeRequests = {
    applyCustomerAnswer: jest
      .fn()
      .mockResolvedValue(
        outcome === 'rejected'
          ? { outcome: 'rejected', reason: 'stale_cycle' }
          : { outcome: 'applied' },
      ),
  };
  const service = new WhatsAppWebhookService(
    { findById: jest.fn() } as any,
    verificationHub as any,
    { findByProviderMessageId: jest.fn().mockResolvedValue(undefined) } as any,
    adminLifecycles as any,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    changeRequests as any,
  );
  return { service, adminLifecycles, verificationHub };
}

describe('WhatsAppWebhookService admin lifecycle on cycle buttons', () => {
  it.each(['confirmed', 'canceled'] as const)(
    'records the %s answer so the store reads as active',
    async (intent) => {
      const { service, adminLifecycles } = setup('applied');

      await service.processIncomingOrThrow(
        buttonMessage(`cr1|${intent}|${VERIFICATION_ID}|1`),
      );

      expect(adminLifecycles.recordMessageStatus).toHaveBeenCalledWith({
        verificationId: VERIFICATION_ID,
        status: intent,
        occurredAt: '2023-11-14T22:13:20.000Z',
      });
    },
  );

  it('records nothing for a rejected answer', async () => {
    const { service, adminLifecycles, verificationHub } = setup('rejected');

    await service.processIncomingOrThrow(
      buttonMessage(`cr1|confirmed|${VERIFICATION_ID}|1`),
    );

    expect(verificationHub.finalizeVerification).not.toHaveBeenCalled();
    expect(adminLifecycles.recordMessageStatus).not.toHaveBeenCalled();
  });
});
