import { WhatsAppWebhookService } from './whatsapp.webhook.service';
import type {
  WhatsAppWebhookPayloadDto,
  WhatsAppChangeValueDto,
} from './dto/whatsapp-webhook.dto';

/* eslint-disable @typescript-eslint/no-unsafe-argument */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wrap(value: WhatsAppChangeValueDto): WhatsAppWebhookPayloadDto {
  return {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value }] }],
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

function textPayload(
  body: string,
  contextWamid?: string,
  timestamp = '1700000000',
): WhatsAppWebhookPayloadDto {
  return wrap({
    messages: [
      {
        type: 'text',
        text: { body },
        ...(contextWamid ? { context: { id: contextWamid } } : {}),
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
    findByWaMessageId: jest.fn().mockResolvedValue(undefined),
    updateStatus: jest.fn().mockResolvedValue([{ id: 'v1' }]),
    updateStatusByWamid: jest.fn().mockResolvedValue([{ id: 'v1' }]),
  };

  const verificationHub = {
    finalizeVerification: jest.fn().mockResolvedValue(undefined),
  };
  const messageDispatches = {
    findByProviderMessageId: jest.fn().mockResolvedValue(undefined),
    recordProviderStatus: jest.fn(),
  };

  const service = new WhatsAppWebhookService(
    verificationsRepo as any,
    verificationHub as any,
    messageDispatches as any,
  );

  return { service, verificationsRepo, verificationHub, messageDispatches };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WhatsAppWebhookService', () => {
  // ---- Status updates (delivered / read / failed) ----

  describe('status updates', () => {
    it('prefers the dispatch ledger for an initial message callback', async () => {
      const { service, verificationsRepo, messageDispatches } = createMocks();
      messageDispatches.findByProviderMessageId.mockResolvedValue({
        id: 'dispatch-1',
        kind: 'initial',
        verificationId: 'v1',
      });

      await service.processIncoming(statusPayload('wamid_ledger', 'delivered'));

      expect(messageDispatches.recordProviderStatus).toHaveBeenCalledWith(
        'dispatch-1',
        'delivered',
        '2023-11-14T22:13:20.000Z',
      );
      expect(verificationsRepo.updateStatus).toHaveBeenCalledWith(
        'v1',
        'delivered',
        undefined,
        '1700000000',
      );
      expect(verificationsRepo.updateStatusByWamid).not.toHaveBeenCalled();
    });

    it('advances the verification on a follow-up callback', async () => {
      // A delivered or read receipt on the reminder is the same evidence as one
      // on the initial message: the customer received and opened something. The
      // terminal guard inside `updateStatus` is what stops a late follow-up
      // receipt from disturbing a verification the customer already answered.
      const { service, verificationsRepo, messageDispatches } = createMocks();
      messageDispatches.findByProviderMessageId.mockResolvedValue({
        id: 'dispatch-2',
        kind: 'follow_up',
        verificationId: 'v1',
      });

      await service.processIncoming(statusPayload('wamid_follow_up', 'read'));

      expect(messageDispatches.recordProviderStatus).toHaveBeenCalledTimes(1);
      expect(verificationsRepo.updateStatus).toHaveBeenCalledWith(
        'v1',
        'read',
        undefined,
        '1700000000',
      );
      // Resolved through the ledger, never by re-pointing at the wamid index.
      expect(verificationsRepo.updateStatusByWamid).not.toHaveBeenCalled();
    });

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

    it('should confirm a no_reply verification before merchant cancellation', async () => {
      const { service, verificationsRepo, verificationHub } = createMocks();
      verificationsRepo.findById.mockResolvedValue({
        id: 'v1',
        status: 'no_reply',
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

    it('should cancel a no_reply verification before merchant cancellation', async () => {
      const { service, verificationsRepo, verificationHub } = createMocks();
      verificationsRepo.findById.mockResolvedValue({
        id: 'v1',
        status: 'no_reply',
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

  // ---- Free-text replies (no quick-reply button tapped) ----

  describe('free-text replies', () => {
    it.each([
      ['نعم', 'confirmed'],
      ['تأكيد', 'confirmed'],
      ['Yes', 'confirmed'],
      ['1', 'confirmed'],
      ['لا', 'canceled'],
      ['إلغاء', 'canceled'],
      ['Cancel', 'canceled'],
      ['2', 'canceled'],
    ])('resolves %s to %s via the replied-to message', async (body, status) => {
      const { service, verificationsRepo, verificationHub } = createMocks();
      verificationsRepo.findByWaMessageId.mockResolvedValue({ id: 'v1' });

      await service.processIncoming(textPayload(body, 'wamid_template'));

      expect(verificationsRepo.findByWaMessageId).toHaveBeenCalledWith(
        'wamid_template',
      );
      expect(verificationsRepo.updateStatus).toHaveBeenCalledWith(
        'v1',
        status,
        undefined,
        '1700000000',
        status === 'canceled' ? { cancellationSource: 'customer' } : {},
      );
      expect(verificationHub.finalizeVerification).toHaveBeenCalledWith(
        'v1',
        status,
      );
    });

    it('ignores a text reply that carries no context to match on', async () => {
      const { service, verificationsRepo } = createMocks();

      await service.processIncoming(textPayload('نعم'));

      expect(verificationsRepo.findByWaMessageId).not.toHaveBeenCalled();
      expect(verificationsRepo.updateStatus).not.toHaveBeenCalled();
    });

    it('ignores an answer that is neither a yes nor a no', async () => {
      const { service, verificationsRepo } = createMocks();

      await service.processIncoming(
        textPayload('when will it arrive?', 'wamid_template'),
      );

      expect(verificationsRepo.updateStatus).not.toHaveBeenCalled();
    });

    it('ignores a reply whose context matches no verification', async () => {
      const { service, verificationsRepo } = createMocks();
      verificationsRepo.findByWaMessageId.mockResolvedValue(undefined);

      await service.processIncoming(textPayload('نعم', 'wamid_unknown'));

      expect(verificationsRepo.updateStatus).not.toHaveBeenCalled();
    });

    it('lets a merchant cancellation outrank a late text confirmation', async () => {
      const { service, verificationsRepo, verificationHub } = createMocks();
      verificationsRepo.findByWaMessageId.mockResolvedValue({ id: 'v1' });
      verificationsRepo.findById.mockResolvedValue({
        id: 'v1',
        merchantCanceledAt: '2026-09-05T10:00:00.000Z',
      });

      await service.processIncoming(textPayload('نعم', 'wamid_template'));

      expect(verificationsRepo.updateStatus).not.toHaveBeenCalled();
      expect(verificationHub.finalizeVerification).not.toHaveBeenCalled();
    });
  });

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
