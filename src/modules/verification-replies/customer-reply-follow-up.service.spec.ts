import { Logger } from '@nestjs/common';
import {
  MESSAGE_IMPROVEMENT_SWITCHES_OFF,
  type MessageImprovementSwitchState,
} from '../../shared/config/whatsapp-template.config';
import type { FreeFormTextOutcome } from '../../shared/ports/messaging.port';
import {
  CustomerReplyFollowUpService,
  type CustomerReplyFollowUp,
} from './customer-reply-follow-up.service';

const NOW = Date.parse('2026-10-06T12:00:00.000Z');
const TEXTS: Record<string, string> = {
  'ack_confirmed.ar.default': 'تم تأكيد طلبك رقم #{{order}} من {{store}}.',
  'ack_confirmed.ar.egyptian': 'طلبك رقم #{{order}} من {{store}} اتأكد.',
  'ack_canceled.en.default':
    'Your order #{{order}} from {{store}} is cancelled.',
  'unresolved_reply_nudge.en.default': 'Please tap a button.',
  'fallback_store_name.en.default': 'our store',
};

function setup(
  options: {
    switches?: Partial<MessageImprovementSwitchState>;
    verification?: Record<string, unknown>;
    order?: Record<string, unknown>;
    integration?: Record<string, unknown>;
    dispatch?: { resolvedLanguage: 'ar' | 'en'; variantKey: string } | null;
    claimed?: boolean;
    send?: FreeFormTextOutcome | Error;
    texts?: Record<string, string>;
  } = {},
) {
  const verification = {
    id: 'ver-1',
    orgId: 'org-1',
    orderId: 'order-1',
    status: 'confirmed',
    confirmationSource: 'customer',
    cancellationSource: null,
    merchantCanceledAt: null,
    ...options.verification,
  };
  const order = {
    id: 'order-1',
    orgId: 'org-1',
    isTest: false,
    customerPhone: '+201001112223',
    orderNumber: '1117',
    externalOrderId: 'ext-1',
    integration: {
      defaultLanguage: 'auto',
      storeName: 'Nour',
      ...options.integration,
    },
    ...options.order,
  };
  const serviceMessages = {
    claim: jest
      .fn()
      .mockResolvedValue(options.claimed === false ? null : { id: 'msg-1' }),
    markSent: jest.fn().mockResolvedValue(undefined),
    markNotSent: jest.fn().mockResolvedValue(undefined),
  };
  const texts = options.texts ?? TEXTS;
  const messageTexts = {
    resolve: jest.fn(
      (purpose: string, language: string, style?: string | null) => {
        const own = style
          ? texts[`${purpose}.${language}.${style}`]
          : undefined;
        const found = own ?? texts[`${purpose}.${language}.default`];
        return Promise.resolve(
          found ? { body: found, style: own ? style : 'default' } : null,
        );
      },
    ),
  };
  const send = options.send ?? {
    outcome: 'accepted',
    providerMessageId: 'wamid.text-1',
  };
  const messagingPort = {
    sendVerificationTemplate: jest.fn(),
    sendFreeFormText: jest.fn(() =>
      send instanceof Error ? Promise.reject(send) : Promise.resolve(send),
    ),
  };
  const dispatches = {
    findLatestAcceptedIdentity: jest
      .fn()
      .mockResolvedValue(
        options.dispatch === undefined
          ? { resolvedLanguage: 'ar', variantKey: 'ar.egyptian_v2' }
          : options.dispatch,
      ),
  };
  const switches = {
    ...MESSAGE_IMPROVEMENT_SWITCHES_OFF,
    acknowledgment: true,
    unresolvedReplyNudge: true,
    ...options.switches,
  };
  const service = new CustomerReplyFollowUpService(
    { findById: jest.fn().mockResolvedValue(verification) } as never,
    { findById: jest.fn().mockResolvedValue(order) } as never,
    dispatches as never,
    serviceMessages as never,
    messageTexts as never,
    messagingPort as never,
    { current: () => switches } as never,
  );
  return { service, serviceMessages, messagingPort, messageTexts };
}

const ACK: CustomerReplyFollowUp = {
  kind: 'acknowledgment',
  verificationId: 'ver-1',
  orgId: 'org-1',
  repliedAt: new Date(NOW - 60_000).toISOString(),
  intent: 'confirmed',
};
const NUDGE: CustomerReplyFollowUp = {
  kind: 'nudge',
  verificationId: 'ver-1',
  orgId: 'org-1',
  repliedAt: new Date(NOW - 60_000).toISOString(),
};

describe('CustomerReplyFollowUpService (US-08-07 b, c)', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  describe('acknowledgment', () => {
    it('sends once after a customer confirms, in the language and dialect of the latest send', async () => {
      const { service, serviceMessages, messagingPort } = setup();
      await expect(service.handle(ACK)).resolves.toEqual({
        outcome: 'sent',
        providerMessageId: 'wamid.text-1',
      });
      expect(serviceMessages.claim).toHaveBeenCalledWith({
        orgId: 'org-1',
        verificationId: 'ver-1',
        kind: 'acknowledgment',
        repliedAt: ACK.repliedAt,
      });
      expect(messagingPort.sendFreeFormText).toHaveBeenCalledWith({
        to: '+201001112223',
        body: 'طلبك رقم #1117 من Nour اتأكد.',
        verificationId: 'ver-1',
      });
      expect(serviceMessages.markSent).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'msg-1',
          providerMessageId: 'wamid.text-1',
          text: {
            purpose: 'ack_confirmed',
            language: 'ar',
            style: 'egyptian',
          },
        }),
      );
    });

    it('sends after a customer cancel, and uses the default text when the dialect has none', async () => {
      const { service, messagingPort } = setup({
        verification: {
          status: 'canceled',
          confirmationSource: null,
          cancellationSource: 'customer',
        },
        dispatch: { resolvedLanguage: 'en', variantKey: 'en.direct' },
      });
      await service.handle({ ...ACK, intent: 'canceled' });
      expect(messagingPort.sendFreeFormText).toHaveBeenCalledWith(
        expect.objectContaining({
          body: 'Your order #1117 from Nour is cancelled.',
        }),
      );
    });

    it.each([
      [
        'a merchant cancellation',
        {
          verification: {
            status: 'canceled',
            cancellationSource: 'merchant',
            merchantCanceledAt: '2026-10-06T11:00:00Z',
          },
        },
        'canceled',
        'merchant_canceled',
      ],
      [
        'a cancellation another source recorded',
        {
          verification: {
            status: 'canceled',
            confirmationSource: null,
            cancellationSource: 'merchant',
          },
        },
        'canceled',
        'not_customer_answer',
      ],
      [
        'an automatic no_reply',
        { verification: { status: 'no_reply', confirmationSource: null } },
        'confirmed',
        'not_customer_answer',
      ],
      ['a test order', { order: { isTest: true } }, 'confirmed', 'test_order'],
      [
        'the switch off',
        { switches: { acknowledgment: false } },
        'confirmed',
        'switch_off',
      ],
    ] as const)(
      'never sends after %s, and claims nothing',
      async (_label, options, intent, reason) => {
        const { service, serviceMessages, messagingPort } = setup(options);
        await expect(service.handle({ ...ACK, intent })).resolves.toEqual({
          outcome: 'ineligible',
          reason,
        });
        expect(serviceMessages.claim).not.toHaveBeenCalled();
        expect(messagingPort.sendFreeFormText).not.toHaveBeenCalled();
      },
    );

    it('a replay finds the claim taken and sends nothing', async () => {
      const { service, messagingPort } = setup({ claimed: false });
      await expect(service.handle(ACK)).resolves.toEqual({
        outcome: 'ineligible',
        reason: 'already_handled',
      });
      expect(messagingPort.sendFreeFormText).not.toHaveBeenCalled();
    });
  });

  describe('window and outcomes', () => {
    it('outside the 24-hour window, records the skip and sends nothing', async () => {
      const { service, serviceMessages, messagingPort } = setup();
      await expect(
        service.handle({
          ...ACK,
          repliedAt: new Date(NOW - 24 * 3_600_000).toISOString(),
        }),
      ).resolves.toEqual({ outcome: 'skipped', reason: 'outside_window' });
      expect(serviceMessages.markNotSent).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'msg-1',
          state: 'skipped',
          reason: 'outside_window',
        }),
      );
      expect(messagingPort.sendFreeFormText).not.toHaveBeenCalled();
    });

    it('records 131047 as a window_closed skip, never a retry', async () => {
      const { service, serviceMessages, messagingPort } = setup({
        send: { outcome: 'window_closed' },
      });
      await expect(service.handle(ACK)).resolves.toEqual({
        outcome: 'skipped',
        reason: 'window_closed',
      });
      expect(messagingPort.sendFreeFormText).toHaveBeenCalledTimes(1);
      expect(serviceMessages.markNotSent).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'skipped', reason: 'window_closed' }),
      );
    });

    it.each([
      [{ outcome: 'rejected', code: 'provider_rejected' }, 'provider_rejected'],
      [{ outcome: 'failed', code: 'x' }, 'provider_error'],
      [new Error('boom'), 'provider_error'],
    ] as const)('records a failed send as failed, %#', async (send, reason) => {
      const { service, serviceMessages } = setup({ send });
      await expect(service.handle(ACK)).resolves.toEqual({
        outcome: 'failed',
        reason,
      });
      expect(serviceMessages.markNotSent).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'failed', reason }),
      );
    });

    it('with no text for the language, records text_unavailable', async () => {
      const { service, messagingPort } = setup({ texts: {} });
      await expect(service.handle(ACK)).resolves.toEqual({
        outcome: 'skipped',
        reason: 'text_unavailable',
      });
      expect(messagingPort.sendFreeFormText).not.toHaveBeenCalled();
    });

    it('fills a missing store name from the fallback text, and skips when there is none', async () => {
      const fallback = setup({
        verification: {
          status: 'canceled',
          confirmationSource: null,
          cancellationSource: 'customer',
        },
        dispatch: { resolvedLanguage: 'en', variantKey: 'en.friendly' },
        integration: { storeName: ' ' },
      });
      await fallback.service.handle({ ...ACK, intent: 'canceled' });
      expect(fallback.messagingPort.sendFreeFormText).toHaveBeenCalledWith(
        expect.objectContaining({
          body: 'Your order #1117 from our store is cancelled.',
        }),
      );
      const none = setup({ integration: { storeName: null } });
      await expect(none.service.handle(ACK)).resolves.toEqual({
        outcome: 'skipped',
        reason: 'text_unavailable',
      });
    });

    it('without an accepted send, reads the language from the number', async () => {
      const { service, messageTexts } = setup({
        dispatch: null,
        order: { customerPhone: '+14155550101' },
        verification: { status: 'pending', confirmationSource: null },
      });
      await service.handle(NUDGE);
      expect(messageTexts.resolve).toHaveBeenCalledWith(
        'unresolved_reply_nudge',
        'en',
        null,
      );
    });
  });

  describe('nudge', () => {
    it('sends one nudge while the verification is open', async () => {
      const { service, serviceMessages, messagingPort } = setup({
        verification: { status: 'read', confirmationSource: null },
        dispatch: { resolvedLanguage: 'en', variantKey: 'en.friendly' },
      });
      await expect(service.handle(NUDGE)).resolves.toMatchObject({
        outcome: 'sent',
      });
      expect(serviceMessages.claim).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'nudge' }),
      );
      expect(messagingPort.sendFreeFormText).toHaveBeenCalledWith(
        expect.objectContaining({ body: 'Please tap a button.' }),
      );
    });

    it.each(['confirmed', 'canceled', 'no_reply', 'failed', 'expired'])(
      'sends nothing once the verification is %s',
      async (status) => {
        const { service, serviceMessages } = setup({
          verification: { status },
        });
        await expect(service.handle(NUDGE)).resolves.toEqual({
          outcome: 'ineligible',
          reason: 'verification_closed',
        });
        expect(serviceMessages.claim).not.toHaveBeenCalled();
      },
    );

    it('with the switch off, sends nothing', async () => {
      const { service } = setup({
        switches: { unresolvedReplyNudge: false },
        verification: { status: 'sent' },
      });
      await expect(service.handle(NUDGE)).resolves.toEqual({
        outcome: 'ineligible',
        reason: 'switch_off',
      });
    });
  });
});
