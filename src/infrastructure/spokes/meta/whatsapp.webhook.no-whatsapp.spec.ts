import { WhatsAppWebhookService } from './whatsapp.webhook.service';
import type { WhatsAppWebhookPayloadDto } from './dto/whatsapp-webhook.dto';

function failedReceipt(
  wamid: string,
  code: number | string,
  timestamp = '1700000000',
): WhatsAppWebhookPayloadDto {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              statuses: [
                {
                  id: wamid,
                  status: 'failed',
                  timestamp,
                  errors: [{ code, title: 'Message undeliverable' }],
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function createMocks() {
  const verificationsRepo = {
    findById: jest.fn(),
    findByWaMessageId: jest.fn().mockResolvedValue(undefined),
    updateStatus: jest.fn(),
    updateStatusByWamid: jest.fn(),
  };
  const verificationHub = {
    finalizeVerification: jest.fn().mockResolvedValue(undefined),
    markNoWhatsApp: jest.fn().mockResolvedValue(undefined),
  };
  const messageDispatches = {
    resolveOrParkReceipt: jest
      .fn()
      .mockResolvedValue({ outcome: 'verification' }),
    recordProviderStatus: jest.fn(),
  };
  const service = new WhatsAppWebhookService(
    verificationsRepo as never,
    verificationHub as never,
    messageDispatches as never,
  );
  return { service, verificationsRepo, verificationHub, messageDispatches };
}

describe('WhatsAppWebhookService: number not on WhatsApp', () => {
  it('runs the no-WhatsApp follow-through once the receipt moved the row', async () => {
    const { service, verificationsRepo, verificationHub } = createMocks();
    verificationsRepo.updateStatusByWamid.mockResolvedValue([
      { id: 'v1', status: 'no_whatsapp' },
    ]);

    await service.processIncoming(failedReceipt('wamid_1', 131026));

    expect(verificationsRepo.updateStatusByWamid).toHaveBeenCalledWith(
      'wamid_1',
      'failed',
      '1700000000',
      { code: 131026, title: 'Message undeliverable' },
    );
    expect(verificationHub.markNoWhatsApp).toHaveBeenCalledTimes(1);
    expect(verificationHub.markNoWhatsApp).toHaveBeenCalledWith(
      'v1',
      'receipt',
    );
  });

  it('does nothing more for a duplicate receipt the protected status refused', async () => {
    const { service, verificationsRepo, verificationHub } = createMocks();
    verificationsRepo.updateStatusByWamid
      .mockResolvedValueOnce([{ id: 'v1', status: 'no_whatsapp' }])
      .mockResolvedValueOnce([]);

    await service.processIncoming(failedReceipt('wamid_1', 131026));
    await service.processIncoming(failedReceipt('wamid_1', 131026));

    expect(verificationHub.markNoWhatsApp).toHaveBeenCalledTimes(1);
  });

  it('does nothing more when a delivery already outranked the report', async () => {
    // The SQL keeps a delivered or read row's status; the row comes back as
    // it was, not as `no_whatsapp`.
    const { service, verificationsRepo, verificationHub } = createMocks();
    verificationsRepo.updateStatusByWamid.mockResolvedValue([
      { id: 'v1', status: 'read' },
    ]);

    await service.processIncoming(failedReceipt('wamid_1', 131026));

    expect(verificationHub.markNoWhatsApp).not.toHaveBeenCalled();
  });

  it('keeps the generic failure handling for other error codes', async () => {
    const { service, verificationsRepo, verificationHub } = createMocks();
    verificationsRepo.updateStatusByWamid.mockResolvedValue([
      { id: 'v1', status: 'failed' },
    ]);

    await service.processIncoming(failedReceipt('wamid_1', 131049));

    expect(verificationsRepo.updateStatusByWamid).toHaveBeenCalledWith(
      'wamid_1',
      'failed',
      '1700000000',
      { code: 131049, title: 'Message undeliverable' },
    );
    expect(verificationHub.markNoWhatsApp).not.toHaveBeenCalled();
  });

  it('follows through on a prepaid dispatch projection', async () => {
    const { service, verificationsRepo, verificationHub, messageDispatches } =
      createMocks();
    messageDispatches.resolveOrParkReceipt.mockResolvedValue({
      outcome: 'dispatch',
      dispatch: { id: 'dispatch-1', kind: 'initial', verificationId: 'v1' },
    });
    messageDispatches.recordProviderStatus.mockResolvedValue({
      verificationRows: [{ id: 'v1', status: 'no_whatsapp' }],
    });

    await service.processIncoming(failedReceipt('wamid_1', '131026'));

    expect(messageDispatches.recordProviderStatus).toHaveBeenCalledWith(
      'dispatch-1',
      'failed',
      '2023-11-14T22:13:20.000Z',
      { code: '131026', title: 'Message undeliverable' },
    );
    expect(verificationsRepo.updateStatus).not.toHaveBeenCalled();
    expect(verificationHub.markNoWhatsApp).toHaveBeenCalledWith(
      'v1',
      'receipt',
    );
  });

  it('follows through on a periodic-plan dispatch through updateStatus', async () => {
    const { service, verificationsRepo, verificationHub, messageDispatches } =
      createMocks();
    messageDispatches.resolveOrParkReceipt.mockResolvedValue({
      outcome: 'dispatch',
      dispatch: { id: 'dispatch-1', kind: 'initial', verificationId: 'v1' },
    });
    // Periodic plan: the ledger records the receipt and releases usage, the
    // caller projects the verification.
    messageDispatches.recordProviderStatus.mockResolvedValue(undefined);
    verificationsRepo.updateStatus.mockResolvedValue([
      { id: 'v1', status: 'no_whatsapp' },
    ]);

    await service.processIncoming(failedReceipt('wamid_1', 131026));

    expect(verificationsRepo.updateStatus).toHaveBeenCalledWith(
      'v1',
      'failed',
      undefined,
      '1700000000',
      undefined,
      { code: 131026, title: 'Message undeliverable' },
    );
    expect(verificationHub.markNoWhatsApp).toHaveBeenCalledWith(
      'v1',
      'receipt',
    );
  });

  it('parks an early receipt and leaves the follow-through to the acceptance', async () => {
    const { service, verificationHub, messageDispatches } = createMocks();
    messageDispatches.resolveOrParkReceipt.mockResolvedValue({
      outcome: 'parked',
    });

    await service.processIncoming(failedReceipt('wamid_1', 131026));

    expect(verificationHub.markNoWhatsApp).not.toHaveBeenCalled();
  });
});
