/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Logger } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { MetaSendContextService } from './meta-send-context.service';
import { encryptConnectionSecret } from './whatsapp-connection-credentials';
import { WhatsAppService } from '../whatsapp.service';
import type { MessagingPort } from '../../../../shared/ports/messaging.port';

const key = 'a'.repeat(64);
const merchantToken = 'merchant-secret+/value';
const params: Parameters<MessagingPort['sendVerificationTemplate']>[0] = {
  to: '+201000000001',
  verificationId: 'verification',
  orderNumber: '1',
  totalPrice: '100',
  template: {
    registryKey: 'cod_confirm.ar.egyptian',
    variantKey: 'ar.egyptian',
    language: 'ar',
    templateName: 'confirm_eg',
    languageCode: 'ar_EG',
    parameterFormat: 'named',
    variables: [],
    imageHeader: {
      templateName: 'confirm_eg_image',
      languageCode: 'ar_EG',
      imageUrl: 'https://example.test/logo.png',
    },
  },
  sender: {
    kind: 'merchant_own',
    connectionId: 'connection',
    reason: 'own_number',
    units: 1,
  },
  dispatchContext: {
    orgId: 'org',
    dispatchId: 'dispatch',
    merchantAttempt: { attemptId: 'attempt', claimToken: 'claim' },
  },
};

function setup() {
  const values: Record<string, unknown> = {
    whatsappOwnNumber: { sendingEnabled: true },
    WA_ACCESS_TOKEN: 'shared-secret',
    WA_PHONE_NUMBER_ID: 'shared-phone',
    SHOPIFY_TOKEN_ENCRYPTION_KEY: key,
  };
  const config = { get: (name: string) => values[name] };
  const dispatch = {
    state: 'sending',
    senderKind: 'merchant_own',
    senderConnectionId: 'connection',
    senderReason: 'own_number',
    senderPhoneNumberId: 'merchant-phone',
    templateName: 'confirm_eg',
    languageCode: 'ar_EG',
  };
  const connection = {
    id: 'connection',
    orgId: 'org',
    phoneNumberId: 'merchant-phone',
    state: 'active',
    degradedClass: null,
    businessTokenEncrypted: encryptConnectionSecret(merchantToken, key),
  };
  const dispatches = {
    findForSender: jest.fn().mockResolvedValue(dispatch),
    authorizeMerchantAttempt: jest.fn().mockResolvedValue(true),
  };
  const connections = { findByOrg: jest.fn().mockResolvedValue(connection) };
  const templates = {
    findForSend: jest
      .fn()
      .mockResolvedValue({ status: 'approved', category: 'utility' }),
  };
  const reader = new MetaSendContextService(
    config as never,
    dispatches as never,
    connections as never,
    templates as never,
  );
  const http = {
    post: jest
      .fn()
      .mockReturnValue(of({ data: { messages: [{ id: 'wamid' }] } })),
  };
  const adapter = new WhatsAppService(http as never, config as never, reader);
  return {
    values,
    dispatch,
    connection,
    dispatches,
    connections,
    templates,
    reader,
    http,
    adapter,
  };
}

describe('claimed merchant sender', () => {
  afterEach(() => jest.restoreAllMocks());

  it('uses the merchant phone, token, text template and a 15 second timeout', async () => {
    const { adapter, http, dispatches, connections, templates } = setup();
    expect(await adapter.sendVerificationTemplate(params)).toMatchObject({
      messages: [{ id: 'wamid' }],
    });
    expect(http.post).toHaveBeenCalledWith(
      expect.stringContaining('/merchant-phone/messages'),
      expect.objectContaining({
        template: expect.objectContaining({
          name: 'confirm_eg',
          language: { code: 'ar_EG' },
          components: expect.not.arrayContaining([
            expect.objectContaining({ type: 'header' }),
          ]),
        }),
      }),
      {
        timeout: 15_000,
        headers: {
          Authorization: `Bearer ${merchantToken}`,
          'Content-Type': 'application/json',
        },
      },
    );
    expect(dispatches.findForSender).toHaveBeenCalledWith(
      'org',
      'dispatch',
      'verification',
    );
    expect(connections.findByOrg).toHaveBeenCalledWith('org');
    expect(templates.findForSend).toHaveBeenCalledWith(
      'org',
      'connection',
      params.template,
    );
  });

  it.each(['missing', 'plaintext', 'damaged', 'wrong-key'] as const)(
    'refuses %s credentials before HTTP',
    async (mode) => {
      const { adapter, http, connection } = setup();
      connection.businessTokenEncrypted =
        mode === 'missing'
          ? (null as never)
          : mode === 'plaintext'
            ? merchantToken
            : mode === 'damaged'
              ? 'v1:bad:tag:data'
              : encryptConnectionSecret(merchantToken, 'b'.repeat(64));
      await expect(
        adapter.sendVerificationTemplate(params),
      ).rejects.toMatchObject({ code: 'sender_credentials_unavailable' });
      expect(http.post).not.toHaveBeenCalled();
    },
  );

  it('the kill switch fences retries before connection/template reads', async () => {
    const { adapter, http, values, connections, templates } = setup();
    values.whatsappOwnNumber = { sendingEnabled: false };
    await expect(
      adapter.sendVerificationTemplate(params),
    ).rejects.toMatchObject({ code: 'own_number_sending_disabled' });
    expect(http.post).not.toHaveBeenCalled();
    expect(connections.findByOrg).not.toHaveBeenCalled();
    expect(templates.findForSend).not.toHaveBeenCalled();
  });

  it.each([
    'dispatch',
    'kind',
    'reason',
    'connection-id',
    'phone',
    'state',
    'degraded',
    'template-status',
    'template-category',
  ] as const)('refuses changed %s before HTTP', async (mode) => {
    const { adapter, http, dispatches, dispatch, connection, templates } =
      setup();
    if (mode === 'dispatch') dispatches.findForSender.mockResolvedValue(null);
    if (mode === 'kind') dispatch.senderKind = 'akeed_system';
    if (mode === 'reason') dispatch.senderReason = 'other';
    if (mode === 'connection-id') connection.id = 'other-tenant-connection';
    if (mode === 'phone') connection.phoneNumberId = 'reconnected-phone';
    if (mode === 'state') connection.state = 'verifying';
    if (mode === 'degraded') connection.degradedClass = 'payment' as never;
    if (mode === 'template-status')
      templates.findForSend.mockResolvedValue({
        status: 'paused',
        category: 'utility',
      });
    if (mode === 'template-category')
      templates.findForSend.mockResolvedValue({
        status: 'approved',
        category: 'marketing',
      });
    await expect(adapter.sendVerificationTemplate(params)).rejects.toThrow();
    expect(http.post).not.toHaveBeenCalled();
  });

  it('keeps the shared timeout and header behavior, without connection queries', async () => {
    const { adapter, http, dispatch, connections, templates } = setup();
    dispatch.senderKind = 'akeed_system';
    dispatch.senderConnectionId = null as never;
    dispatch.senderReason = 'feature_off';
    dispatch.senderPhoneNumberId = 'recorded-shared-phone';
    await adapter.sendVerificationTemplate({
      ...params,
      sender: {
        kind: 'akeed_system',
        connectionId: null,
        reason: 'feature_off',
        units: 1,
      },
    });
    expect(http.post).toHaveBeenCalledWith(
      expect.stringContaining('/recorded-shared-phone/messages'),
      expect.objectContaining({
        template: expect.objectContaining({ name: 'confirm_eg_image' }),
      }),
      expect.not.objectContaining({ timeout: expect.anything() }),
    );
    expect(connections.findByOrg).not.toHaveBeenCalled();
    expect(templates.findForSend).not.toHaveBeenCalled();
  });

  it.each(['network', 'provider'])(
    'redacts both tokens, encoded tokens and nested causes from %s errors',
    async (mode) => {
      const { adapter, http } = setup();
      const logs = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      const message = [
        merchantToken,
        encodeURIComponent(merchantToken),
        'shared-secret',
      ].join(' ');
      http.post.mockReturnValue(
        throwError(() =>
          mode === 'provider'
            ? {
                isAxiosError: true,
                message,
                response: {
                  status: 400,
                  data: { error: { code: 190, message, type: message } },
                },
              }
            : Object.assign(
                new Error(message, {
                  cause: Object.assign(new Error(message), { code: message }),
                }),
                { code: message },
              ),
        ),
      );
      let thrown = '';
      try {
        await adapter.sendVerificationTemplate(params);
      } catch (error) {
        thrown = String(error);
      }
      const output = thrown + JSON.stringify(logs.mock.calls);
      expect(output).not.toContain(merchantToken);
      expect(output).not.toContain(encodeURIComponent(merchantToken));
      expect(output).not.toContain('shared-secret');
      if (mode === 'network') expect(output).toContain('[REDACTED]');
      expect(http.post).toHaveBeenCalledTimes(1);
    },
  );

  it('isolates concurrent merchant credentials and their error redaction', async () => {
    const { reader, http, adapter, connections } = setup();
    connections.findByOrg.mockImplementation((orgId: string) =>
      Promise.resolve({
        id: 'connection',
        phoneNumberId: 'merchant-phone',
        state: 'active',
        degradedClass: null,
        businessTokenEncrypted: encryptConnectionSecret(
          orgId === 'org' ? merchantToken : 'second-secret',
          key,
        ),
      }),
    );
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    http.post.mockImplementation(
      (
        _url: string,
        _payload: unknown,
        config: { headers: { Authorization: string } },
      ) => throwError(() => new Error(config.headers.Authorization)),
    );
    const results = await Promise.allSettled([
      adapter.sendVerificationTemplate(params),
      adapter.sendVerificationTemplate({
        ...params,
        dispatchContext: { orgId: 'other-org', dispatchId: 'dispatch' },
      }),
    ]);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(String((results[0] as PromiseRejectedResult).reason)).not.toContain(
      merchantToken,
    );
    expect(String((results[1] as PromiseRejectedResult).reason)).not.toContain(
      'second-secret',
    );
    expect(reader).toBeDefined();
  });
});
