import { WhatsAppWebhookService } from './whatsapp.webhook.service';
import type { WhatsAppWebhookPayloadDto } from './dto/whatsapp-webhook.dto';

/* eslint-disable @typescript-eslint/no-unsafe-argument */

function message(fields: Record<string, unknown>): WhatsAppWebhookPayloadDto {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                { from: '201012345678', timestamp: '1700000000', ...fields },
              ],
            },
          },
        ],
      },
    ],
  } as WhatsAppWebhookPayloadDto;
}

function setup(committed: string[] = []) {
  const verificationsRepo = {
    findById: jest
      .fn()
      .mockResolvedValue({ id: 'v1', merchantCanceledAt: null }),
    findByWaMessageId: jest.fn().mockResolvedValue({ id: 'v1' }),
    updateStatus: jest.fn().mockResolvedValue([{ id: 'v1' }]),
  };
  const verificationHub = {
    finalizeVerification: jest.fn().mockResolvedValue(undefined),
  };
  const messageDispatches = {
    findByProviderMessageId: jest.fn().mockResolvedValue(undefined),
  };
  const autoCancellations = {
    recordCustomerMessage: jest
      .fn()
      .mockResolvedValue({ matched: ['v1'], committed }),
  };
  const service = new WhatsAppWebhookService(
    verificationsRepo as any,
    verificationHub as any,
    messageDispatches as any,
    undefined,
    undefined,
    undefined,
    undefined,
    autoCancellations as any,
  );
  return { service, verificationsRepo, verificationHub, autoCancellations };
}

describe('WhatsAppWebhookService and automatic cancellation', () => {
  it('records a plain message that quotes nothing by the sender number', async () => {
    const { service, autoCancellations, verificationsRepo } = setup();

    await service.processIncoming(
      message({ type: 'text', text: { body: 'Can I change the address?' } }),
    );

    expect(autoCancellations.recordCustomerMessage).toHaveBeenCalledWith({
      phoneE164: '+201012345678',
      verificationIds: [],
      receivedAt: new Date(1700000000 * 1000).toISOString(),
    });
    expect(verificationsRepo.updateStatus).not.toHaveBeenCalled();
  });

  it('records media and button messages too, with the order they name', async () => {
    const { service, autoCancellations } = setup();

    await service.processIncoming(message({ type: 'image' }));
    await service.processIncoming(
      message({ type: 'button', button: { payload: 'confirm_v1' } }),
    );

    expect(autoCancellations.recordCustomerMessage).toHaveBeenCalledTimes(2);
    expect(autoCancellations.recordCustomerMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ verificationIds: ['v1'] }),
    );
  });

  it('still confirms an order whose cancellation has not reached the store', async () => {
    const { service, verificationsRepo } = setup([]);

    await service.processIncoming(
      message({ type: 'button', button: { payload: 'confirm_v1' } }),
    );

    expect(verificationsRepo.updateStatus).toHaveBeenCalledWith(
      'v1',
      'confirmed',
      undefined,
      '1700000000',
      { confirmationSource: 'customer' },
    );
  });

  it('leaves the status of an order the store is already canceling', async () => {
    const { service, verificationsRepo, verificationHub } = setup(['v1']);

    await service.processIncoming(
      message({ type: 'button', button: { payload: 'confirm_v1' } }),
    );

    expect(verificationsRepo.updateStatus).not.toHaveBeenCalled();
    expect(verificationHub.finalizeVerification).not.toHaveBeenCalled();
  });

  it('handles the reply as before when recording fails', async () => {
    const { service, verificationsRepo, autoCancellations } = setup();
    autoCancellations.recordCustomerMessage.mockRejectedValue(
      new Error('database unavailable'),
    );

    await service.processIncoming(
      message({ type: 'button', button: { payload: 'cancel_v1' } }),
    );

    expect(verificationsRepo.updateStatus).toHaveBeenCalledWith(
      'v1',
      'canceled',
      undefined,
      '1700000000',
      { cancellationSource: 'customer' },
    );
  });
});
