import { Logger } from '@nestjs/common';
import { WhatsAppWebhookService } from './whatsapp.webhook.service';

const VERIFICATION_ID = 'a3f1c2d4-5b6e-4f70-8a91-b2c3d4e5f607';

const reply = (answer: 'confirm' | 'cancel' = 'confirm') => ({
  entry: [
    {
      changes: [
        {
          field: 'messages',
          value: {
            messages: [
              {
                id: 'wamid.reply',
                timestamp: '1767268800',
                type: 'button',
                button: { payload: `${answer}_${VERIFICATION_ID}` },
              },
            ],
          },
        },
      ],
    },
  ],
});

function setup(verification: Record<string, unknown>, rows: unknown[]) {
  const verificationsRepo = {
    findById: jest.fn().mockResolvedValue({
      id: VERIFICATION_ID,
      orgId: 'org-1',
      merchantCanceledAt: null,
      ...verification,
    }),
    updateStatus: jest.fn().mockResolvedValue(rows),
  };
  const hub = { finalizeVerification: jest.fn().mockResolvedValue(undefined) };
  const lifecycles = {
    recordMessageStatus: jest.fn().mockResolvedValue(undefined),
  };
  const automation = {
    enqueueAcknowledgment: jest.fn().mockResolvedValue(undefined),
  };
  const switches = {
    current: () => ({ acknowledgment: true, unresolvedReplyNudge: false }),
  };
  const service = new WhatsAppWebhookService(
    verificationsRepo as never,
    hub as never,
    {
      acknowledgmentEnabledForVerification: jest.fn().mockResolvedValue(true),
    } as never,
    lifecycles as never,
    switches as never,
    undefined,
    automation as never,
  );
  return { service, verificationsRepo, hub, lifecycles, automation };
}

describe('WhatsAppWebhookService on a worker', () => {
  beforeEach(() => {
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation();
    }
  });

  afterEach(() => jest.restoreAllMocks());

  it('passes an error up to the worker', async () => {
    const { service, verificationsRepo } = setup({ status: 'sent' }, []);
    verificationsRepo.updateStatus.mockRejectedValue(new Error('database'));

    await expect(
      service.processIncomingOrThrow(reply() as never),
    ).rejects.toThrow('database');
  });

  it('keeps the inline path answering, whatever failed', async () => {
    const { service, verificationsRepo } = setup({ status: 'sent' }, []);
    verificationsRepo.updateStatus.mockRejectedValue(new Error('database'));

    await expect(service.processIncoming(reply() as never)).resolves.toEqual({
      status: 'error',
      message: 'Internal Server Error',
    });
  });

  describe('a reply saved before the run stopped', () => {
    const saved = { status: 'confirmed', confirmationSource: 'customer' };

    it('reaches the store on a retry, only if not already synced', async () => {
      const { service, hub } = setup(saved, []);

      await service.processIncomingOrThrow(reply() as never, { isRetry: true });

      expect(hub.finalizeVerification).toHaveBeenCalledWith(
        VERIFICATION_ID,
        'confirmed',
        { skipIfSynced: true },
      );
    });

    it('finishes the lifecycle record and acknowledgment on a retry', async () => {
      const { service, lifecycles, automation } = setup(saved, []);

      await service.processIncomingOrThrow(reply() as never, { isRetry: true });

      expect(lifecycles.recordMessageStatus).toHaveBeenCalledTimes(1);
      expect(automation.enqueueAcknowledgment).toHaveBeenCalledTimes(1);
    });

    it('handles a cancellation the same way', async () => {
      const { service, hub } = setup(
        { status: 'canceled', cancellationSource: 'customer' },
        [],
      );

      await service.processIncomingOrThrow(reply('cancel') as never, {
        isRetry: true,
      });

      expect(hub.finalizeVerification).toHaveBeenCalledTimes(1);
    });

    it('does nothing on a first run, as today', async () => {
      const { service, hub, lifecycles, automation } = setup(saved, []);

      await service.processIncomingOrThrow(reply() as never);

      expect(hub.finalizeVerification).not.toHaveBeenCalled();
      expect(lifecycles.recordMessageStatus).not.toHaveBeenCalled();
      expect(automation.enqueueAcknowledgment).not.toHaveBeenCalled();
    });

    it('does nothing inline, as today', async () => {
      const { service, hub } = setup(saved, []);

      await service.processIncoming(reply() as never);

      expect(hub.finalizeVerification).not.toHaveBeenCalled();
    });
  });

  it.each([
    [
      'a different answer',
      { status: 'canceled', cancellationSource: 'customer' },
    ],
    ['the merchant', { status: 'confirmed', confirmationSource: 'merchant' }],
    ['no source', { status: 'confirmed', confirmationSource: null }],
  ])(
    'leaves an order alone on a retry when it was settled by %s',
    async (_case, verification) => {
      const { service, hub } = setup(verification, []);

      await service.processIncomingOrThrow(reply() as never, { isRetry: true });

      expect(hub.finalizeVerification).not.toHaveBeenCalled();
    },
  );

  it('runs a normal reply on a retry with no extra options', async () => {
    const { service, hub } = setup({ status: 'sent' }, [
      { id: VERIFICATION_ID },
    ]);

    await service.processIncomingOrThrow(reply() as never, { isRetry: true });

    expect(hub.finalizeVerification).toHaveBeenCalledWith(
      VERIFICATION_ID,
      'confirmed',
    );
  });
});
