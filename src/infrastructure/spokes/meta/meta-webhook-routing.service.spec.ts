import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { MetaWebhookRoutingService } from './meta-webhook-routing.service';
import type { WhatsAppWebhookPayloadDto } from './dto/whatsapp-webhook.dto';
import type { WebhookRunOptions } from './whatsapp.webhook.service';
import {
  WHATSAPP_TEMPLATE_CONFIG,
  parseWhatsappTemplateConfig,
} from '../../../shared/config/whatsapp-template.config';

const conn = {
  id: 'connection-a',
  orgId: 'org-a',
  wabaId: '100',
  phoneNumberId: '200',
  displayPhoneNumber: '+20 100 000 0000',
  signupGeneration: 1,
};
function setup() {
  const connections = {
    findLiveByPhoneNumberId: jest.fn().mockResolvedValue(conn),
    findLiveByWabaId: jest.fn().mockResolvedValue(conn),
  };
  const customers = {
    admit: jest.fn().mockResolvedValue({
      allowed: true,
      retainText: true,
      verificationId: 'verification-a',
    }),
    receiptReceiverMatches: jest.fn().mockResolvedValue(true),
  };
  const messages = {
    processIncomingOrThrow: jest
      .fn<Promise<void>, [WhatsAppWebhookPayloadDto, WebhookRunOptions]>()
      .mockResolvedValue(undefined),
  };
  const templates = { handleOrThrow: jest.fn().mockResolvedValue(undefined) };
  const lifecycle = {
    apply: jest.fn().mockResolvedValue(undefined),
    requestHealth: jest.fn().mockResolvedValue(undefined),
  };
  const config = new ConfigService({
    WA_PHONE_NUMBER_ID: 'system-phone',
    [WHATSAPP_TEMPLATE_CONFIG]: parseWhatsappTemplateConfig({
      WA_BUSINESS_ACCOUNT_ID: '999',
    }),
  });
  const router = new MetaWebhookRoutingService(
    config,
    connections as never,
    customers as never,
    messages as never,
    templates as never,
    lifecycle as never,
  );
  return { connections, customers, messages, templates, lifecycle, router };
}
function payload(
  field: string | undefined = 'messages',
  value: Record<string, unknown> = {},
  waba = '100',
) {
  return Buffer.from(
    JSON.stringify({
      entry: [
        {
          id: waba,
          time: 1793710800,
          changes: [
            {
              field,
              value: { metadata: { phone_number_id: '200' }, ...value },
            },
          ],
        },
      ],
    }),
  );
}
const message = {
  id: 'incoming-1',
  type: 'text',
  from_user_id: 'synthetic-user',
  text: { body: 'hello-private' },
  context: { id: 'old-attempt-wamid' },
};

describe('signed Meta webhook routing', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation());
  afterEach(() => jest.restoreAllMocks());

  it('routes merchant messages with a trusted org and persisted association', async () => {
    const s = setup();
    await s.router.process(
      await s.router.prepare(payload('messages', { messages: [message] })),
    );
    expect(s.messages.processIncomingOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: [expect.objectContaining({ id: '100' })],
      }),
      expect.objectContaining({
        receivingOrgId: 'org-a',
        receivingSender: {
          connectionId: 'connection-a',
          phoneNumberId: '200',
          signupGeneration: 1,
        },
        replyBindings: { 'incoming-1': 'verification-a' },
      }),
    );
    expect(s.customers.admit).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-a' }),
      expect.objectContaining({
        from_user_id: 'synthetic-user',
        from: undefined,
      }),
    );
  });

  it.each(['smb_message_echoes', 'history', 'smb_app_state_sync', 'unknown'])(
    'strips %s content before storage and never invokes reply handling',
    async (field) => {
      const s = setup();
      const safe = await s.router.prepare(
        payload(field, {
          messages: [message],
          message_echoes: [message],
          arbitrary: 'hello-private',
        }),
      );
      expect(safe.toString()).not.toContain('hello-private');
      await s.router.process(safe);
      expect(s.messages.processIncomingOrThrow).not.toHaveBeenCalled();
      expect(s.customers.admit).not.toHaveBeenCalled();
    },
  );

  it('drops missing fields rather than treating them as messages', async () => {
    const s = setup();
    const raw = Buffer.from(
      '{"entry":[{"id":"100","changes":[{"value":{"messages":[{"id":"x","text":{"body":"hello-private"}}]}}]}]}',
    );
    const safe = await s.router.prepare(raw);
    await s.router.process(safe);
    expect(safe.toString()).not.toContain('hello-private');
    expect(s.messages.processIncomingOrThrow).not.toHaveBeenCalled();
  });

  it('drops foreign messages before any reply handler runs', async () => {
    const s = setup();
    s.customers.admit.mockResolvedValue({
      allowed: false,
      retainText: false,
      verificationId: null,
    } as never);
    const safe = await s.router.prepare(
      payload('messages', { messages: [message] }),
    );
    expect(safe.toString()).not.toContain('hello-private');
    await s.router.process(safe);
    expect(
      s.messages.processIncomingOrThrow.mock.calls[0][0].entry?.[0].changes?.[0]
        .value?.messages,
    ).toEqual([]);
  });

  it('strips unqualified text and sender identifiers before persistence', async () => {
    const s = setup();
    s.customers.admit.mockResolvedValue({
      allowed: true,
      retainText: false,
      verificationId: null,
    } as never);
    const safe = await s.router.prepare(
      payload('messages', { messages: [message] }),
    );
    expect(safe.toString()).not.toContain('hello-private');
    expect(safe.toString()).not.toContain('synthetic-user');
  });

  it.each(['missing', 'wrong_waba'])('drops a %s receiver', async (kind) => {
    const s = setup();
    if (kind === 'missing')
      s.connections.findLiveByPhoneNumberId.mockResolvedValue(null as never);
    const safe = await s.router.prepare(
      payload(
        'messages',
        { messages: [message] },
        kind === 'wrong_waba' ? '101' : '100',
      ),
    );
    expect(safe.toString()).not.toContain('hello-private');
    expect(s.customers.admit).not.toHaveBeenCalled();
  });

  it('routes the configured shared number without an org phone lookup', async () => {
    const s = setup();
    await s.router.process(
      payload(
        'messages',
        { metadata: { phone_number_id: 'system-phone' }, messages: [message] },
        '999',
      ),
    );
    expect(s.connections.findLiveByPhoneNumberId).not.toHaveBeenCalled();
    expect(s.customers.admit).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: null }),
      expect.anything(),
    );
  });

  it('keeps late receipts after a disconnect, subject to ledger receiver validation', async () => {
    const s = setup();
    s.connections.findLiveByPhoneNumberId.mockResolvedValue(null as never);
    await s.router.process(
      payload('messages', {
        statuses: [{ id: 'old-wamid', status: 'delivered' }],
      }),
    );
    expect(s.customers.receiptReceiverMatches).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'old-wamid' }),
      '200',
      '100',
      null,
    );
    expect(
      s.messages.processIncomingOrThrow.mock.calls[0][0].entry?.[0].changes?.[0]
        .value?.statuses,
    ).toHaveLength(1);
  });

  it('refuses a receipt on the wrong receiving number', async () => {
    const s = setup();
    s.customers.receiptReceiverMatches.mockResolvedValue(false);
    await s.router.process(
      payload('messages', {
        statuses: [{ id: 'foreign-wamid', status: 'read' }],
      }),
    );
    expect(
      s.messages.processIncomingOrThrow.mock.calls[0][0].entry?.[0].changes?.[0]
        .value?.statuses,
    ).toEqual([]);
  });

  it.each([
    'PARTNER_REMOVED',
    'PARTNER_APP_UNINSTALLED',
    'ACCOUNT_DELETED',
    'ACCOUNT_OFFBOARDED',
    'ACCOUNT_RECONNECTED',
    'ACCOUNT_RESTRICTION',
    'ACCOUNT_VIOLATION',
    'DISABLED_UPDATE',
  ])('routes lifecycle %s by WABA', async (event) => {
    const s = setup();
    await s.router.process(
      await s.router.prepare(
        payload('account_update', {
          event,
          disconnection_info: { reason: 'PRIMARY_INACTIVITY' },
        }),
      ),
    );
    expect(s.lifecycle.apply).toHaveBeenCalledWith(
      conn,
      expect.objectContaining({ event, reason: 'PRIMARY_INACTIVITY' }),
    );
    expect(s.messages.processIncomingOrThrow).not.toHaveBeenCalled();
  });

  it.each([
    'account_review_update',
    'business_capability_update',
    'phone_number_quality_update',
  ])('requests health for %s', async (field) => {
    const s = setup();
    await s.router.process(
      payload(field, { display_phone_number: '201000000000' }),
    );
    expect(s.lifecycle.requestHealth).toHaveBeenCalledWith(conn);
  });
  it('refuses quality for another number in the account', async () => {
    const s = setup();
    await s.router.process(
      payload('phone_number_quality_update', {
        display_phone_number: '201111111111',
      }),
    );
    expect(s.lifecycle.requestHealth).not.toHaveBeenCalled();
  });
});
