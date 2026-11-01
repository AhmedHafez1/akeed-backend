import { ValidationPipe } from '@nestjs/common';
import { WhatsAppWebhookService } from './whatsapp.webhook.service';
import { WhatsAppWebhookPayloadDto } from './dto/whatsapp-webhook.dto';

/**
 * Payload shapes from Meta's current webhook references. A customer with a
 * username can arrive with no phone number at all, so nothing here may depend
 * on `from`, `wa_id` or `recipient_id`, and `conversation` is usually absent.
 */
const VERIFICATION_ID = '4f7b1f4e-44b3-4a57-8a79-52e4d8f4a111';

function envelope(value: Record<string, unknown>) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '15550001111',
                phone_number_id: 'phone-1',
              },
              ...value,
            },
          },
        ],
      },
    ],
  };
}

function usernameContacts() {
  return [
    {
      user_id: 'EG.13491208655302741918',
      profile: { name: 'Customer', username: 'customer.one' },
    },
  ];
}

const pipe = new ValidationPipe({
  whitelist: true,
  transform: true,
  forbidNonWhitelisted: false,
});

function parse(payload: unknown): Promise<WhatsAppWebhookPayloadDto> {
  return pipe.transform(payload, {
    type: 'body',
    metatype: WhatsAppWebhookPayloadDto,
  }) as Promise<WhatsAppWebhookPayloadDto>;
}

function createService() {
  const verificationsRepo = {
    findById: jest.fn().mockResolvedValue({ id: VERIFICATION_ID }),
    findByWaMessageId: jest.fn().mockResolvedValue({ id: VERIFICATION_ID }),
    updateStatus: jest.fn().mockResolvedValue([{ id: VERIFICATION_ID }]),
    updateStatusByWamid: jest.fn().mockResolvedValue([{ id: VERIFICATION_ID }]),
  };
  const verificationHub = {
    finalizeVerification: jest.fn().mockResolvedValue(undefined),
  };
  const messageDispatches = {
    resolveOrParkReceipt: jest
      .fn()
      .mockResolvedValue({ outcome: 'verification' }),
    findByProviderMessageId: jest.fn().mockResolvedValue(undefined),
    recordProviderStatus: jest.fn(),
  };
  const service = new WhatsAppWebhookService(
    verificationsRepo as never,
    verificationHub as never,
    messageDispatches as never,
  );
  return { service, verificationsRepo, messageDispatches };
}

describe('WhatsApp webhooks on current Meta payloads', () => {
  it('applies a quoted text reply that has no phone number', async () => {
    const { service, verificationsRepo } = createService();
    const payload = await parse(
      envelope({
        contacts: usernameContacts(),
        messages: [
          {
            from_user_id: 'EG.13491208655302741918',
            id: 'wamid.reply',
            timestamp: '1790000000',
            type: 'text',
            text: { body: 'confirm' },
            context: { id: 'wamid.confirmation' },
          },
        ],
      }),
    );

    await expect(service.processIncoming(payload)).resolves.toEqual({
      status: 'success',
    });
    expect(verificationsRepo.findByWaMessageId).toHaveBeenCalledWith(
      'wamid.confirmation',
    );
    expect(verificationsRepo.updateStatus).toHaveBeenCalledTimes(1);
  });

  it('applies a delivered receipt with no recipient_id or conversation', async () => {
    const { service, messageDispatches } = createService();
    const payload = await parse(
      envelope({
        statuses: [
          {
            id: 'wamid.confirmation',
            status: 'delivered',
            timestamp: '1790000000',
            recipient_user_id: 'EG.13491208655302741918',
            pricing: {
              pricing_model: 'PMP',
              type: 'regular',
              category: 'utility',
            },
          },
        ],
      }),
    );

    await expect(service.processIncoming(payload)).resolves.toEqual({
      status: 'success',
    });
    expect(messageDispatches.resolveOrParkReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        providerMessageId: 'wamid.confirmation',
        status: 'delivered',
      }),
    );
  });

  it('keeps the error code of a failed receipt', async () => {
    const { service, messageDispatches } = createService();
    const payload = await parse(
      envelope({
        statuses: [
          {
            id: 'wamid.confirmation',
            status: 'failed',
            timestamp: '1790000000',
            recipient_user_id: 'EG.13491208655302741918',
            errors: [
              {
                code: 131026,
                title: 'Message undeliverable',
                message: 'Message undeliverable',
                error_data: { details: 'Unable to deliver' },
              },
            ],
          },
        ],
      }),
    );

    await service.processIncoming(payload);

    expect(messageDispatches.resolveOrParkReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        failureInfo: { code: 131026, title: 'Message undeliverable' },
      }),
    );
  });

  it('ignores a played status', async () => {
    const { service, messageDispatches } = createService();
    const payload = await parse(
      envelope({
        statuses: [
          { id: 'wamid.voice', status: 'played', timestamp: '1790000000' },
        ],
      }),
    );

    await expect(service.processIncoming(payload)).resolves.toEqual({
      status: 'success',
    });
    expect(messageDispatches.resolveOrParkReceipt).not.toHaveBeenCalled();
  });
});
