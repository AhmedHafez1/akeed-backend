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
            field: 'messages',
            value: {
              messages: [
                {
                  id: 'wamid.customer-1',
                  from: '201012345678',
                  timestamp: '1700000000',
                  ...fields,
                },
              ],
            },
          },
        ],
      },
    ],
  } as WhatsAppWebhookPayloadDto;
}

function setup(
  options: {
    confirmationCycle?: number;
    updatedRows?: unknown[];
    resolve?: () => Promise<unknown>;
    existing?: Record<string, unknown>;
  } = {},
) {
  const verificationsRepo = {
    findById: jest.fn().mockResolvedValue({
      id: 'v1',
      orgId: 'org-1',
      merchantCanceledAt: null,
      confirmationCycle: options.confirmationCycle ?? 1,
      ...options.existing,
    }),
    updateStatus: jest
      .fn()
      .mockResolvedValue(options.updatedRows ?? [{ id: 'v1' }]),
  };
  const verificationHub = {
    finalizeVerification: jest.fn().mockResolvedValue(undefined),
  };
  const messageDispatches = {
    findByProviderMessageId: jest.fn().mockResolvedValue(undefined),
  };
  const changeRequests = {
    resolveByCustomerAnswer: jest.fn(
      options.resolve ??
        (() =>
          Promise.resolve({
            outcome: 'resolved',
            request: { id: 'cr-1', resolution: 'customer_confirmed' },
          })),
    ),
  };
  const service = new WhatsAppWebhookService(
    verificationsRepo as any,
    verificationHub as any,
    messageDispatches as any,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    changeRequests as any,
  );
  return { service, verificationsRepo, verificationHub, changeRequests };
}

describe('WhatsAppWebhookService and change requests', () => {
  it.each([
    ['confirm_v1', 'confirmed'],
    ['cancel_v1', 'canceled'],
  ] as const)(
    'closes an open request when the customer taps %s, before merchant contact',
    async (payload, intent) => {
      const { service, changeRequests, verificationHub } = setup();

      await service.processIncomingOrThrow(
        message({ type: 'button', button: { payload } }),
      );

      expect(changeRequests.resolveByCustomerAnswer).toHaveBeenCalledWith({
        verificationId: 'v1',
        intent,
        eventId: 'wamid.customer-1',
        occurredAt: '2023-11-14T22:13:20.000Z',
      });
      expect(verificationHub.finalizeVerification).toHaveBeenCalledWith(
        'v1',
        intent,
      );
    },
  );

  it('finishes the close on a retry of an answer that was already saved', async () => {
    const { service, changeRequests } = setup({
      updatedRows: [],
      existing: {
        status: 'confirmed',
        confirmationSource: 'customer',
        customerActionAt: '2023-11-14T22:13:20.000Z',
        customerActionEventId: 'wamid.customer-1',
      },
    });

    await service.processIncomingOrThrow(
      message({ type: 'button', button: { payload: 'confirm_v1' } }),
      { isRetry: true },
    );

    expect(changeRequests.resolveByCustomerAnswer).toHaveBeenCalledTimes(1);
  });

  it('closes nothing when the answer did not change the order', async () => {
    const { service, changeRequests, verificationHub } = setup({
      updatedRows: [],
    });

    await service.processIncomingOrThrow(
      message({ type: 'button', button: { payload: 'confirm_v1' } }),
    );

    expect(changeRequests.resolveByCustomerAnswer).not.toHaveBeenCalled();
    expect(verificationHub.finalizeVerification).not.toHaveBeenCalled();
  });

  it('ignores a button of a cycle an updated confirmation retired', async () => {
    const { service, changeRequests, verificationsRepo, verificationHub } =
      setup({ confirmationCycle: 2 });

    await service.processIncomingOrThrow(
      message({ type: 'button', button: { payload: 'confirm_v1' } }),
    );

    expect(verificationsRepo.updateStatus).not.toHaveBeenCalled();
    expect(changeRequests.resolveByCustomerAnswer).not.toHaveBeenCalled();
    expect(verificationHub.finalizeVerification).not.toHaveBeenCalled();
  });

  it('still syncs the answer when closing the request fails', async () => {
    const { service, verificationHub } = setup({
      resolve: () => Promise.reject(new Error('database unavailable')),
    });

    await service.processIncomingOrThrow(
      message({ type: 'button', button: { payload: 'confirm_v1' } }),
    );

    expect(verificationHub.finalizeVerification).toHaveBeenCalledWith(
      'v1',
      'confirmed',
    );
  });
});
