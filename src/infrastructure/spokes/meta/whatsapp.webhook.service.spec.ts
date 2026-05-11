import { WhatsAppWebhookService } from './whatsapp.webhook.service';
import { WhatsAppWebhookPayloadDto } from './dto/whatsapp-webhook.dto';

/* eslint-disable @typescript-eslint/no-unsafe-argument */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wrap(value: Record<string, unknown>): WhatsAppWebhookPayloadDto {
  return {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: value as any }] }],
  };
}

function statusPayload(
  wamid: string,
  status: string,
  timestamp = '1700000000',
): WhatsAppWebhookPayloadDto {
  return wrap({ statuses: [{ id: wamid, status, timestamp }] });
}

function buttonPayload(
  payload: string,
  timestamp = '1700000000',
): WhatsAppWebhookPayloadDto {
  return wrap({
    messages: [{ type: 'button', button: { payload }, timestamp }],
  });
}

function interactivePayload(
  id: string,
  timestamp = '1700000000',
): WhatsAppWebhookPayloadDto {
  return wrap({
    messages: [
      {
        type: 'interactive',
        interactive: { button_reply: { id } },
        timestamp,
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function createMocks() {
  const verificationsRepo = {
    findById: jest.fn(),
    updateStatus: jest.fn().mockResolvedValue([{ id: 'v1' }]),
    updateStatusByWamid: jest.fn().mockResolvedValue([{ id: 'v1' }]),
  };

  const verificationHub = {
    finalizeVerification: jest.fn().mockResolvedValue(undefined),
  };

  const service = new WhatsAppWebhookService(
    verificationsRepo as any,
    verificationHub as any,
  );

  return { service, verificationsRepo, verificationHub };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WhatsAppWebhookService', () => {
  // ---- Status updates (delivered / read / failed) ----

  describe('status updates', () => {
    it('should update status to delivered via wamid', async () => {
      const { service, verificationsRepo } = createMocks();

      const result = await service.processIncoming(
        statusPayload('wamid_123', 'delivered'),
      );

      expect(result).toEqual({ status: 'success' });
      expect(verificationsRepo.updateStatusByWamid).toHaveBeenCalledWith(
        'wamid_123',
        'delivered',
        '1700000000',
      );
    });

    it('should update status to read via wamid', async () => {
      const { service, verificationsRepo } = createMocks();

      await service.processIncoming(statusPayload('wamid_456', 'read'));

      expect(verificationsRepo.updateStatusByWamid).toHaveBeenCalledWith(
        'wamid_456',
        'read',
        '1700000000',
      );
    });

    it('should update status to failed via wamid', async () => {
      const { service, verificationsRepo } = createMocks();

      await service.processIncoming(statusPayload('wamid_789', 'failed'));

      expect(verificationsRepo.updateStatusByWamid).toHaveBeenCalledWith(
        'wamid_789',
        'failed',
        '1700000000',
      );
    });

    it('should ignore Meta "sent" status callback', async () => {
      const { service, verificationsRepo } = createMocks();

      await service.processIncoming(statusPayload('wamid_001', 'sent'));

      expect(verificationsRepo.updateStatusByWamid).not.toHaveBeenCalled();
    });

    it('should warn when wamid matches no verification', async () => {
      const { service, verificationsRepo } = createMocks();
      verificationsRepo.updateStatusByWamid.mockResolvedValue([]);

      const result = await service.processIncoming(
        statusPayload('wamid_unknown', 'delivered'),
      );

      expect(result).toEqual({ status: 'success' });
      expect(verificationsRepo.updateStatusByWamid).toHaveBeenCalledWith(
        'wamid_unknown',
        'delivered',
        '1700000000',
      );
    });

    it('should skip status objects with missing id or status', async () => {
      const { service, verificationsRepo } = createMocks();

      await service.processIncoming(
        wrap({ statuses: [{ id: '', status: 'delivered' }] }),
      );
      await service.processIncoming(
        wrap({ statuses: [{ id: 'wamid_1', status: '' }] }),
      );

      expect(verificationsRepo.updateStatusByWamid).not.toHaveBeenCalled();
    });
  });

  // ---- Button replies (confirm / cancel) ----

  describe('button replies', () => {
    it('should confirm a verification via button reply', async () => {
      const { service, verificationsRepo, verificationHub } = createMocks();
      verificationsRepo.findById.mockResolvedValue({
        id: 'v1',
        merchantCanceledAt: null,
      });

      await service.processIncoming(buttonPayload('confirm_v1'));

      expect(verificationsRepo.updateStatus).toHaveBeenCalledWith(
        'v1',
        'confirmed',
        undefined,
        '1700000000',
        {},
      );
      expect(verificationHub.finalizeVerification).toHaveBeenCalledWith(
        'v1',
        'confirmed',
      );
    });

    it('should cancel a verification via button reply with customer source', async () => {
      const { service, verificationsRepo, verificationHub } = createMocks();
      verificationsRepo.findById.mockResolvedValue({
        id: 'v1',
        merchantCanceledAt: null,
      });

      await service.processIncoming(buttonPayload('cancel_v1'));

      expect(verificationsRepo.updateStatus).toHaveBeenCalledWith(
        'v1',
        'canceled',
        undefined,
        '1700000000',
        { cancellationSource: 'customer' },
      );
      expect(verificationHub.finalizeVerification).toHaveBeenCalledWith(
        'v1',
        'canceled',
      );
    });

    it('should accept "yes" as confirm alias', async () => {
      const { service, verificationsRepo } = createMocks();
      verificationsRepo.findById.mockResolvedValue({
        id: 'v1',
        merchantCanceledAt: null,
      });

      await service.processIncoming(buttonPayload('yes_v1'));

      expect(verificationsRepo.updateStatus).toHaveBeenCalledWith(
        'v1',
        'confirmed',
        undefined,
        '1700000000',
        {},
      );
    });

    it('should accept "no" as cancel alias', async () => {
      const { service, verificationsRepo } = createMocks();
      verificationsRepo.findById.mockResolvedValue({
        id: 'v1',
        merchantCanceledAt: null,
      });

      await service.processIncoming(buttonPayload('no_v1'));

      expect(verificationsRepo.updateStatus).toHaveBeenCalledWith(
        'v1',
        'canceled',
        undefined,
        '1700000000',
        { cancellationSource: 'customer' },
      );
    });

    it('should block customer reply when merchant already canceled', async () => {
      const { service, verificationsRepo, verificationHub } = createMocks();
      verificationsRepo.findById.mockResolvedValue({
        id: 'v1',
        merchantCanceledAt: '2026-01-01T00:00:00Z',
      });

      await service.processIncoming(buttonPayload('confirm_v1'));

      expect(verificationsRepo.updateStatus).not.toHaveBeenCalled();
      expect(verificationHub.finalizeVerification).not.toHaveBeenCalled();
    });

    it('should not finalize when updateStatus returns no rows', async () => {
      const { service, verificationsRepo, verificationHub } = createMocks();
      verificationsRepo.findById.mockResolvedValue({
        id: 'v1',
        merchantCanceledAt: null,
      });
      verificationsRepo.updateStatus.mockResolvedValue([]);

      await service.processIncoming(buttonPayload('confirm_v1'));

      expect(verificationsRepo.updateStatus).toHaveBeenCalled();
      expect(verificationHub.finalizeVerification).not.toHaveBeenCalled();
    });

    it('should ignore payloads with unknown action', async () => {
      const { service, verificationsRepo } = createMocks();

      await service.processIncoming(buttonPayload('unknown_v1'));

      expect(verificationsRepo.findById).not.toHaveBeenCalled();
      expect(verificationsRepo.updateStatus).not.toHaveBeenCalled();
    });

    it('should ignore payloads with wrong format (no underscore)', async () => {
      const { service, verificationsRepo } = createMocks();

      await service.processIncoming(buttonPayload('confirmv1'));

      expect(verificationsRepo.findById).not.toHaveBeenCalled();
    });

    it('should ignore payloads with too many underscore segments', async () => {
      const { service, verificationsRepo } = createMocks();

      await service.processIncoming(buttonPayload('confirm_v1_extra'));

      expect(verificationsRepo.findById).not.toHaveBeenCalled();
    });
  });

  // ---- Interactive button replies ----

  describe('interactive button replies', () => {
    it('should handle interactive button_reply confirm', async () => {
      const { service, verificationsRepo, verificationHub } = createMocks();
      verificationsRepo.findById.mockResolvedValue({
        id: 'v2',
        merchantCanceledAt: null,
      });

      await service.processIncoming(interactivePayload('confirm_v2'));

      expect(verificationsRepo.updateStatus).toHaveBeenCalledWith(
        'v2',
        'confirmed',
        undefined,
        '1700000000',
        {},
      );
      expect(verificationHub.finalizeVerification).toHaveBeenCalledWith(
        'v2',
        'confirmed',
      );
    });

    it('should handle interactive button_reply cancel', async () => {
      const { service, verificationsRepo } = createMocks();
      verificationsRepo.findById.mockResolvedValue({
        id: 'v2',
        merchantCanceledAt: null,
      });

      await service.processIncoming(interactivePayload('cancel_v2'));

      expect(verificationsRepo.updateStatus).toHaveBeenCalledWith(
        'v2',
        'canceled',
        undefined,
        '1700000000',
        { cancellationSource: 'customer' },
      );
    });
  });

  // ---- Batched payloads ----

  describe('batched payloads', () => {
    it('should process all entries, changes, and statuses', async () => {
      const { service, verificationsRepo } = createMocks();

      const payload: WhatsAppWebhookPayloadDto = {
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                value: {
                  statuses: [
                    { id: 'wamid_a', status: 'delivered', timestamp: '100' },
                  ],
                },
              },
              {
                value: {
                  statuses: [
                    { id: 'wamid_b', status: 'read', timestamp: '200' },
                  ],
                },
              },
            ],
          },
          {
            changes: [
              {
                value: {
                  statuses: [
                    { id: 'wamid_c', status: 'delivered', timestamp: '300' },
                  ],
                },
              },
            ],
          },
        ],
      };

      await service.processIncoming(payload);

      expect(verificationsRepo.updateStatusByWamid).toHaveBeenCalledTimes(3);
      expect(verificationsRepo.updateStatusByWamid).toHaveBeenCalledWith(
        'wamid_a',
        'delivered',
        '100',
      );
      expect(verificationsRepo.updateStatusByWamid).toHaveBeenCalledWith(
        'wamid_b',
        'read',
        '200',
      );
      expect(verificationsRepo.updateStatusByWamid).toHaveBeenCalledWith(
        'wamid_c',
        'delivered',
        '300',
      );
    });

    it('should process multiple messages in one value', async () => {
      const { service, verificationsRepo } = createMocks();
      verificationsRepo.findById.mockResolvedValue({
        id: 'v1',
        merchantCanceledAt: null,
      });

      const payload = wrap({
        messages: [
          {
            type: 'button',
            button: { payload: 'confirm_v1' },
            timestamp: '100',
          },
          {
            type: 'button',
            button: { payload: 'cancel_v2' },
            timestamp: '200',
          },
        ],
      });

      await service.processIncoming(payload);

      expect(verificationsRepo.findById).toHaveBeenCalledTimes(2);
      expect(verificationsRepo.updateStatus).toHaveBeenCalledTimes(2);
    });
  });

  // ---- Edge cases ----

  describe('edge cases', () => {
    it('should return success for empty payload', async () => {
      const { service } = createMocks();

      const result = await service.processIncoming({});
      expect(result).toEqual({ status: 'success' });
    });

    it('should return success for payload with no entry', async () => {
      const { service } = createMocks();

      const result = await service.processIncoming({ entry: [] });
      expect(result).toEqual({ status: 'success' });
    });

    it('should skip changes with no value', async () => {
      const { service, verificationsRepo } = createMocks();

      await service.processIncoming({
        entry: [{ changes: [{ value: undefined }] }],
      } as any);

      expect(verificationsRepo.updateStatusByWamid).not.toHaveBeenCalled();
      expect(verificationsRepo.updateStatus).not.toHaveBeenCalled();
    });

    it('should return error status when handler throws', async () => {
      const { service, verificationsRepo } = createMocks();
      verificationsRepo.updateStatusByWamid.mockRejectedValue(
        new Error('DB error'),
      );

      const result = await service.processIncoming(
        statusPayload('wamid_err', 'delivered'),
      );

      expect(result).toEqual({
        status: 'error',
        message: 'Internal Server Error',
      });
    });
  });
});
