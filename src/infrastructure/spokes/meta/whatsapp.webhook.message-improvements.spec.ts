import { Logger } from '@nestjs/common';
import {
  MESSAGE_IMPROVEMENT_SWITCHES_OFF,
  type MessageImprovementSwitchState,
} from '../../../shared/config/whatsapp-template.config';
import type {
  WhatsAppChangeValueDto,
  WhatsAppWebhookPayloadDto,
} from './dto/whatsapp-webhook.dto';
import { WhatsAppWebhookService } from './whatsapp.webhook.service';

/* eslint-disable @typescript-eslint/no-unsafe-argument */

/**
 * US-08-07 b and c at the webhook: it only stores the unresolved reply and
 * queues work. Nothing is sent inline, and the reply text is never stored.
 */
const TIMESTAMP = '1791892800';
const REPLIED_AT = new Date(Number(TIMESTAMP) * 1000).toISOString();

function wrap(value: WhatsAppChangeValueDto): WhatsAppWebhookPayloadDto {
  return {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value }] }],
  };
}

function text(body: string, contextWamid?: string) {
  return wrap({
    messages: [
      {
        id: 'wamid.reply-1',
        type: 'text',
        text: { body },
        ...(contextWamid ? { context: { id: contextWamid } } : {}),
        timestamp: TIMESTAMP,
      },
    ],
  });
}

function button(payload: string) {
  return wrap({
    messages: [
      {
        id: 'wamid.tap-1',
        type: 'button',
        button: { payload },
        timestamp: TIMESTAMP,
      },
    ],
  });
}

function setup(
  options: {
    switches?: Partial<MessageImprovementSwitchState>;
    verification?: Record<string, unknown> | null;
    byWamid?: boolean;
    serviceMessage?: boolean;
  } = {},
) {
  const verification =
    options.verification === null
      ? undefined
      : {
          id: 'ver-1',
          orgId: 'org-1',
          status: 'read',
          merchantCanceledAt: null,
          ...options.verification,
        };
  const verificationsRepo = {
    findById: jest.fn().mockResolvedValue(verification),
    findByWaMessageId: jest
      .fn()
      .mockResolvedValue(options.byWamid === false ? undefined : verification),
    updateStatus: jest.fn().mockResolvedValue([{ id: 'ver-1' }]),
    updateStatusByWamid: jest.fn().mockResolvedValue([{ id: 'ver-1' }]),
  };
  const messageDispatches = {
    findByProviderMessageId: jest
      .fn()
      .mockResolvedValue(
        options.byWamid === false ? { verificationId: 'ver-1' } : undefined,
      ),
    resolveOrParkReceipt: jest
      .fn()
      .mockResolvedValue({ outcome: 'verification' }),
    recordProviderStatus: jest.fn(),
  };
  const serviceMessages = {
    recordUnresolvedReply: jest.fn().mockResolvedValue(true),
    recordDeliveryFailure: jest
      .fn()
      .mockResolvedValue(options.serviceMessage === true),
    isServiceMessage: jest
      .fn()
      .mockResolvedValue(options.serviceMessage === true),
  };
  const automation = {
    enqueueAcknowledgment: jest.fn().mockResolvedValue(undefined),
    enqueueUnresolvedReplyNudge: jest.fn().mockResolvedValue(undefined),
  };
  const switches = { ...MESSAGE_IMPROVEMENT_SWITCHES_OFF, ...options.switches };
  const service = new WhatsAppWebhookService(
    verificationsRepo as any,
    { finalizeVerification: jest.fn() } as any,
    messageDispatches as any,
    undefined,
    { current: () => switches } as any,
    serviceMessages as any,
    automation as any,
  );
  return {
    service,
    verificationsRepo,
    messageDispatches,
    serviceMessages,
    automation,
  };
}

describe('WhatsAppWebhookService and US-08-07', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  describe('b. acknowledgment', () => {
    it.each([
      ['confirm_ver-1', 'confirmed'],
      ['cancel_ver-1', 'canceled'],
    ])(
      'queues one acknowledgment after the customer taps %s',
      async (payload, intent) => {
        const { service, automation } = setup({
          switches: { acknowledgment: true },
        });
        await service.processIncoming(button(payload));
        expect(automation.enqueueAcknowledgment).toHaveBeenCalledWith({
          verificationId: 'ver-1',
          orgId: 'org-1',
          repliedAt: REPLIED_AT,
          intent,
        });
      },
    );

    it('queues it after a recognized typed answer too', async () => {
      const { service, automation } = setup({
        switches: { acknowledgment: true },
      });
      await service.processIncoming(text('نعم', 'wamid.sent-1'));
      expect(automation.enqueueAcknowledgment).toHaveBeenCalledWith(
        expect.objectContaining({ intent: 'confirmed' }),
      );
    });

    it('queues nothing when the answer changed no row, or the switch is off', async () => {
      const off = setup();
      await off.service.processIncoming(button('confirm_ver-1'));
      expect(off.automation.enqueueAcknowledgment).not.toHaveBeenCalled();

      const terminal = setup({ switches: { acknowledgment: true } });
      terminal.verificationsRepo.updateStatus.mockResolvedValue([]);
      await terminal.service.processIncoming(button('confirm_ver-1'));
      expect(terminal.automation.enqueueAcknowledgment).not.toHaveBeenCalled();
    });

    it('queues nothing after a merchant cancellation', async () => {
      const { service, automation } = setup({
        switches: { acknowledgment: true },
        verification: { merchantCanceledAt: '2026-10-06T00:00:00Z' },
      });
      await service.processIncoming(button('cancel_ver-1'));
      expect(automation.enqueueAcknowledgment).not.toHaveBeenCalled();
    });

    it('a failed enqueue does not fail the webhook or the answer', async () => {
      const { service, automation, verificationsRepo } = setup({
        switches: { acknowledgment: true },
      });
      automation.enqueueAcknowledgment.mockRejectedValue(new Error('redis'));
      await expect(
        service.processIncoming(button('confirm_ver-1')),
      ).resolves.toEqual({ status: 'success' });
      expect(verificationsRepo.updateStatus).toHaveBeenCalled();
    });
  });

  describe('c. nudge after an unresolved typed reply', () => {
    it('stores the reply without its text and queues one nudge', async () => {
      const { service, serviceMessages, automation } = setup({
        switches: { unresolvedReplyNudge: true },
      });
      await service.processIncoming(
        text('when will it arrive?', 'wamid.sent-1'),
      );
      expect(serviceMessages.recordUnresolvedReply).toHaveBeenCalledWith({
        orgId: 'org-1',
        verificationId: 'ver-1',
        providerMessageId: 'wamid.reply-1',
        receivedAt: REPLIED_AT,
      });
      expect(
        JSON.stringify(serviceMessages.recordUnresolvedReply.mock.calls),
      ).not.toContain('arrive');
      expect(automation.enqueueUnresolvedReplyNudge).toHaveBeenCalledWith({
        verificationId: 'ver-1',
        orgId: 'org-1',
        repliedAt: REPLIED_AT,
      });
    });

    it('finds a reply to the first message after a reminder repointed wa_message_id', async () => {
      const { service, messageDispatches, automation } = setup({
        switches: { unresolvedReplyNudge: true },
        byWamid: false,
      });
      await service.processIncoming(text('hello?', 'wamid.first-send'));
      expect(messageDispatches.findByProviderMessageId).toHaveBeenCalledWith(
        'wamid.first-send',
      );
      expect(automation.enqueueUnresolvedReplyNudge).toHaveBeenCalled();
    });

    it('without context.id, stores nothing and queues nothing', async () => {
      const { service, serviceMessages, automation } = setup({
        switches: { unresolvedReplyNudge: true },
      });
      await service.processIncoming(text('hello?'));
      expect(serviceMessages.recordUnresolvedReply).not.toHaveBeenCalled();
      expect(automation.enqueueUnresolvedReplyNudge).not.toHaveBeenCalled();
    });

    it.each([
      ['answered', { status: 'confirmed' }],
      ['run out to no_reply', { status: 'no_reply' }],
      ['canceled by the merchant', { merchantCanceledAt: '2026-10-06' }],
    ])('does nothing for a verification %s', async (_label, verification) => {
      const { service, serviceMessages, automation } = setup({
        switches: { unresolvedReplyNudge: true },
        verification,
      });
      await service.processIncoming(text('hello?', 'wamid.sent-1'));
      expect(serviceMessages.recordUnresolvedReply).not.toHaveBeenCalled();
      expect(automation.enqueueUnresolvedReplyNudge).not.toHaveBeenCalled();
    });

    it('does nothing for an unknown quoted message, or with the switch off', async () => {
      const unknown = setup({
        switches: { unresolvedReplyNudge: true },
        verification: null,
      });
      await unknown.service.processIncoming(text('hello?', 'wamid.other'));
      expect(
        unknown.automation.enqueueUnresolvedReplyNudge,
      ).not.toHaveBeenCalled();

      const off = setup();
      await off.service.processIncoming(text('hello?', 'wamid.sent-1'));
      expect(off.serviceMessages.recordUnresolvedReply).not.toHaveBeenCalled();
      expect(off.automation.enqueueUnresolvedReplyNudge).not.toHaveBeenCalled();
    });

    it('leaves the verification to run out to no_reply: it changes no status', async () => {
      const { service, verificationsRepo } = setup({
        switches: { unresolvedReplyNudge: true },
      });
      await service.processIncoming(text('hello?', 'wamid.sent-1'));
      expect(verificationsRepo.updateStatus).not.toHaveBeenCalled();
    });
  });

  describe('receipts for service messages', () => {
    function status(value: string) {
      return wrap({
        statuses: [{ id: 'wamid.text-1', status: value, timestamp: TIMESTAMP }],
      });
    }

    it('a failed receipt marks the service message and touches nothing else', async () => {
      const { service, serviceMessages, messageDispatches, verificationsRepo } =
        setup({ switches: { acknowledgment: true }, serviceMessage: true });
      await service.processIncoming(status('failed'));
      expect(serviceMessages.recordDeliveryFailure).toHaveBeenCalledWith(
        'wamid.text-1',
      );
      expect(messageDispatches.resolveOrParkReceipt).not.toHaveBeenCalled();
      expect(verificationsRepo.updateStatusByWamid).not.toHaveBeenCalled();
    });

    it('a delivered receipt for a service message is not parked as a dispatch receipt', async () => {
      const { service, messageDispatches } = setup({
        switches: { unresolvedReplyNudge: true },
        serviceMessage: true,
      });
      await service.processIncoming(status('delivered'));
      expect(messageDispatches.resolveOrParkReceipt).not.toHaveBeenCalled();
    });

    it('with both switches off, a receipt goes the old way without a lookup', async () => {
      const { service, serviceMessages, messageDispatches } = setup();
      await service.processIncoming(status('delivered'));
      expect(serviceMessages.isServiceMessage).not.toHaveBeenCalled();
      expect(messageDispatches.resolveOrParkReceipt).toHaveBeenCalled();
    });
  });
});
