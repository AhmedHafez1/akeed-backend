import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { WhatsAppWebhookPayloadDto } from './dto/whatsapp-webhook.dto';
import { WhatsAppWebhookService } from './whatsapp.webhook.service';

/**
 * A staff template test (US-08-05) is sent with an ID that belongs to no
 * verification. These cases pin that whatever comes back for it, a button tap
 * or a typed answer, changes nothing.
 */
function setup() {
  const verificationsRepo = {
    // The ID was never stored, so nothing is found and no row is updated.
    findById: jest.fn().mockResolvedValue(undefined),
    findByWaMessageId: jest.fn().mockResolvedValue(undefined),
    updateStatus: jest.fn().mockResolvedValue([]),
    updateStatusByWamid: jest.fn().mockResolvedValue([]),
  };
  const verificationHub = {
    finalizeVerification: jest.fn().mockResolvedValue(undefined),
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

function message(content: Record<string, unknown>): WhatsAppWebhookPayloadDto {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          { value: { messages: [{ ...content, timestamp: '1700000000' }] } },
        ],
      },
    ],
  } as WhatsAppWebhookPayloadDto;
}

describe('WhatsApp webhook, replies to a staff template test', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it.each(['confirm', 'cancel'])(
    'finalizes nothing when the %s button of a test is tapped',
    async (action) => {
      const { service, verificationsRepo, verificationHub } = setup();
      const testId = randomUUID();

      const result = await service.processIncoming(
        message({ type: 'button', button: { payload: `${action}_${testId}` } }),
      );

      expect(result).toEqual({ status: 'success' });
      expect(verificationsRepo.findById).toHaveBeenCalledWith(testId);
      expect(verificationHub.finalizeVerification).not.toHaveBeenCalled();
    },
  );

  it('ignores a typed answer to a test message', async () => {
    const { service, verificationsRepo, verificationHub } = setup();

    const result = await service.processIncoming(
      message({
        type: 'text',
        text: { body: 'yes' },
        context: { id: 'wamid.staff-test' },
      }),
    );

    expect(result).toEqual({ status: 'success' });
    expect(verificationsRepo.updateStatus).not.toHaveBeenCalled();
    expect(verificationHub.finalizeVerification).not.toHaveBeenCalled();
  });
});
