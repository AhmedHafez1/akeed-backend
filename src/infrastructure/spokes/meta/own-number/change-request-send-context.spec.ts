import { ConfigService } from '@nestjs/config';
import { MetaSendContextService } from './meta-send-context.service';
import { encryptConnectionSecret } from './whatsapp-connection-credentials';
import type { MessagingPort } from '../../../../shared/ports/messaging.port';

/* eslint-disable @typescript-eslint/no-unsafe-assignment */

function setup(own = true) {
  const key = 'b'.repeat(64);
  const config = new ConfigService({
    whatsappOwnNumber: { sendingEnabled: true },
    WA_PHONE_NUMBER_ID: 'shared-phone',
    WA_ACCESS_TOKEN: 'synthetic-shared',
    SHOPIFY_TOKEN_ENCRYPTION_KEY: key,
  });
  const dispatch = {
    state: 'sending',
    kind: 'change_acknowledgment',
    orgId: 'org',
    senderKind: own ? 'merchant_own' : 'akeed_system',
    senderConnectionId: own ? 'connection' : null,
    senderPhoneNumberId: own ? 'own-phone' : 'shared-phone',
    senderConnectionGeneration: 2,
  };
  const connections = {
    findByOrg: jest.fn().mockResolvedValue({
      id: 'connection',
      orgId: 'org',
      phoneNumberId: 'own-phone',
      signupGeneration: 2,
      state: 'active',
      degradedClass: null,
      thankYouEnabled: false,
      businessTokenEncrypted: encryptConnectionSecret('synthetic-own', key),
    }),
  };
  const dispatches = { findForSender: jest.fn().mockResolvedValue(dispatch) };
  const service = new MetaSendContextService(
    config,
    dispatches as never,
    connections as never,
    {} as never,
  );
  const params: Parameters<NonNullable<MessagingPort['sendFreeFormText']>>[0] =
    {
      verificationId: 'verification',
      to: '+201000000000',
      body: 'Request received',
      dispatchContext: { orgId: 'org', dispatchId: 'dispatch' },
      ...(own
        ? {
            sender: {
              kind: 'merchant_own',
              orgId: 'org',
              connectionId: 'connection',
              phoneNumberId: 'own-phone',
              signupGeneration: 2,
              serviceMessageId: 'dispatch',
            },
          }
        : {}),
    };
  return { service, params, dispatch, dispatches, connections };
}
describe('paid change-request service reply authorization', () => {
  it('uses the originating merchant number even when ordinary thank-yous are off', async () => {
    const f = setup();
    expect(await f.service.resolveFreeForm(f.params)).toMatchObject({
      token: 'synthetic-own',
      url: expect.stringContaining('/own-phone/messages'),
      timeout: 15000,
    });
  });
  it('uses the claimed shared number with bounded provider I/O', async () => {
    const f = setup(false);
    expect(await f.service.resolveFreeForm(f.params)).toMatchObject({
      token: 'synthetic-shared',
      url: expect.stringContaining('/shared-phone/messages'),
      timeout: 15000,
    });
  });
  it.each(['phoneNumberId', 'connectionId', 'signupGeneration'] as const)(
    'refuses a different originating %s',
    async (field) => {
      const f = setup();
      const sender = {
        ...f.params.sender!,
        [field]: field === 'signupGeneration' ? 1 : 'foreign',
      };
      await expect(
        f.service.resolveFreeForm({ ...f.params, sender }),
      ).rejects.toMatchObject({ code: 'service_message_sender_unavailable' });
    },
  );
  it('does not authorize another message kind through the paid service path', async () => {
    const f = setup();
    f.dispatch.kind = 'initial';
    await expect(f.service.resolveFreeForm(f.params)).rejects.toMatchObject({
      code: 'service_message_sender_unavailable',
    });
  });
});
