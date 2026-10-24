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

function setup(committed = false) {
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
    recordCustomerAnswer: jest.fn().mockResolvedValue({ committed }),
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
  it('ignores a message it cannot read as an answer', async () => {
    const { service, autoCancellations, verificationsRepo } = setup();

    await service.processIncoming(
      message({
        type: 'text',
        text: { body: 'Can I change the address?' },
        context: { id: 'wamid-1' },
      }),
    );
    await service.processIncoming(message({ type: 'image' }));

    expect(autoCancellations.recordCustomerAnswer).not.toHaveBeenCalled();
    expect(verificationsRepo.updateStatus).not.toHaveBeenCalled();
  });

  it('records a button answer against the order it names', async () => {
    const { service, autoCancellations } = setup();

    await service.processIncoming(
      message({ type: 'button', button: { payload: 'confirm_v1' } }),
    );

    expect(autoCancellations.recordCustomerAnswer).toHaveBeenCalledWith({
      verificationId: 'v1',
      intent: 'confirmed',
      receivedAt: new Date(1700000000 * 1000).toISOString(),
    });
  });

  it('matches a typed answer that quotes the first message after a reminder replaced its id', async () => {
    const { service, verificationsRepo, autoCancellations } = setup();
    verificationsRepo.findByWaMessageId.mockResolvedValue(undefined);
    const messageDispatches = (
      service as unknown as {
        messageDispatches: { findByProviderMessageId: jest.Mock };
      }
    ).messageDispatches;
    messageDispatches.findByProviderMessageId.mockResolvedValue({
      verificationId: 'v1',
    });

    await service.processIncoming(
      message({
        type: 'text',
        text: { body: 'yes' },
        context: { id: 'wamid-first' },
      }),
    );

    expect(messageDispatches.findByProviderMessageId).toHaveBeenCalledWith(
      'wamid-first',
    );
    expect(autoCancellations.recordCustomerAnswer).toHaveBeenCalledWith(
      expect.objectContaining({ verificationId: 'v1', intent: 'confirmed' }),
    );
    expect(verificationsRepo.updateStatus).toHaveBeenCalledWith(
      'v1',
      'confirmed',
      undefined,
      '1700000000',
      { confirmationSource: 'customer' },
    );
  });

  it('records nothing for an order the merchant already canceled', async () => {
    const { service, verificationsRepo, autoCancellations } = setup(true);
    verificationsRepo.findById.mockResolvedValue({
      id: 'v1',
      merchantCanceledAt: '2026-10-01T00:00:00.000Z',
    });

    await service.processIncoming(
      message({ type: 'button', button: { payload: 'confirm_v1' } }),
    );

    expect(autoCancellations.recordCustomerAnswer).not.toHaveBeenCalled();
    expect(verificationsRepo.updateStatus).not.toHaveBeenCalled();
  });

  it('still confirms an order whose cancellation has not reached the store', async () => {
    const { service, verificationsRepo } = setup(false);

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
    const { service, verificationsRepo, verificationHub } = setup(true);

    await service.processIncoming(
      message({ type: 'button', button: { payload: 'confirm_v1' } }),
    );

    expect(verificationsRepo.updateStatus).not.toHaveBeenCalled();
    expect(verificationHub.finalizeVerification).not.toHaveBeenCalled();
  });

  it('handles the answer as before when recording fails', async () => {
    const { service, verificationsRepo, autoCancellations } = setup();
    autoCancellations.recordCustomerAnswer.mockRejectedValue(
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
