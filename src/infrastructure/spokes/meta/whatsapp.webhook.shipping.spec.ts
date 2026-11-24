import { WhatsAppWebhookService } from './whatsapp.webhook.service';
import type { WhatsAppWebhookPayloadDto } from './dto/whatsapp-webhook.dto';
import { customerRecipientHash } from '../../../shared/messaging/change-request-messaging';
import type { MessageImprovementSwitches } from '../../../shared/config/message-improvement-switches';

const VERIFICATION = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';
const CUSTOMER = '201012345678';

function tap(
  payload: string,
  fields: Record<string, unknown> = {},
): WhatsAppWebhookPayloadDto {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: 'akeed-phone' },
              messages: [
                {
                  id: 'wamid.customer-1',
                  from: CUSTOMER,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'button',
                  button: { payload, text: 'x' },
                  context: { id: 'wamid.shipped-1' },
                  ...fields,
                },
              ],
            },
          },
        ],
      },
    ],
  } as unknown as WhatsAppWebhookPayloadDto;
}

function setup(
  options: {
    dispatch?: Record<string, unknown> | null;
    recorded?: boolean;
    acknowledgment?: boolean;
    optedIn?: boolean;
  } = {},
) {
  const dispatch =
    options.dispatch === null
      ? undefined
      : {
          id: 'dispatch-1',
          orgId: 'org-1',
          kind: 'shipping_shipped',
          verificationId: VERIFICATION,
          recipientHash: customerRecipientHash(CUSTOMER),
          senderKind: 'akeed_system',
          senderPhoneNumberId: 'akeed-phone',
          ...options.dispatch,
        };
  const messageDispatches = {
    findByProviderMessageId: jest.fn().mockResolvedValue(dispatch),
    acknowledgmentEnabledForVerification: jest
      .fn()
      .mockResolvedValue(options.optedIn ?? true),
  };
  const verificationsRepo = {
    findById: jest.fn(),
    updateStatus: jest.fn(),
  };
  const verificationHub = { finalizeVerification: jest.fn() };
  const changeRequests = { applyCustomerAnswer: jest.fn() };
  const automation = {
    enqueueShippingAcknowledgment: jest.fn(),
    enqueueAcknowledgment: jest.fn(),
  };
  const switches = {
    current: () => ({ acknowledgment: options.acknowledgment ?? true }),
  } as unknown as MessageImprovementSwitches;
  const shipping = {
    recordCustomerReply: jest.fn().mockResolvedValue({
      recorded: options.recorded ?? true,
      deliveryRequest: true,
    }),
  };
  const service = new WhatsAppWebhookService(
    verificationsRepo as never,
    verificationHub as never,
    messageDispatches as never,
    undefined,
    switches,
    undefined,
    automation as never,
    undefined,
    undefined,
    undefined,
    changeRequests as never,
    undefined,
    undefined,
    shipping as never,
  );
  return {
    service,
    shipping,
    automation,
    verificationsRepo,
    changeRequests,
    verificationHub,
  };
}

describe('WhatsAppWebhookService: Shipped message taps', () => {
  it.each(['home', 'reschedule', 'address'] as const)(
    'records a %s tap bound to its Shipped message, and thanks the customer',
    async (reply) => {
      const { service, shipping, automation } = setup();
      await service.processIncomingOrThrow(tap(`sh1|${reply}|${VERIFICATION}`));
      expect(shipping.recordCustomerReply).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: 'org-1',
          verificationId: VERIFICATION,
          reply,
        }),
      );
      expect(automation.enqueueShippingAcknowledgment).toHaveBeenCalledWith(
        expect.objectContaining({
          verificationId: VERIFICATION,
          orgId: 'org-1',
        }),
      );
      expect(automation.enqueueAcknowledgment).not.toHaveBeenCalled();
    },
  );

  it('never treats a tap as a confirmation answer', async () => {
    const { service, verificationsRepo, changeRequests, verificationHub } =
      setup();
    await service.processIncomingOrThrow(tap(`sh1|home|${VERIFICATION}`));
    expect(verificationsRepo.updateStatus).not.toHaveBeenCalled();
    expect(changeRequests.applyCustomerAnswer).not.toHaveBeenCalled();
    expect(verificationHub.finalizeVerification).not.toHaveBeenCalled();
  });

  it('a later tap changes nothing and sends no second thank-you', async () => {
    const { service, automation } = setup({ recorded: false });
    await service.processIncomingOrThrow(tap(`sh1|address|${VERIFICATION}`));
    expect(automation.enqueueShippingAcknowledgment).not.toHaveBeenCalled();
  });

  it.each([
    ['no quoted message', null, { context: undefined }],
    ['an unknown quoted message', null, {}],
    ['a confirmation message', { kind: 'initial' }, {}],
    [
      'another order',
      { verificationId: '2b4e28ba-2fa1-11d2-883f-0016d3cca427' },
      {},
    ],
    ['another recipient', { recipientHash: 'someone-else' }, {}],
    ['another sender', { senderKind: 'merchant_own' }, {}],
    ['another phone number', { senderPhoneNumberId: 'other-phone' }, {}],
  ])('ignores a tap that quotes %s', async (_label, dispatch, fields) => {
    const { service, shipping } = setup(
      dispatch === null ? { dispatch: null } : { dispatch },
    );
    await service.processIncomingOrThrow(
      tap(`sh1|reschedule|${VERIFICATION}`, fields),
    );
    expect(shipping.recordCustomerReply).not.toHaveBeenCalled();
  });

  it('ignores a tap received by another store', async () => {
    const { service, shipping } = setup();
    await service.processIncomingOrThrow(tap(`sh1|home|${VERIFICATION}`), {
      receivingOrgId: 'org-2',
    });
    expect(shipping.recordCustomerReply).not.toHaveBeenCalled();
  });

  it.each([`sh1|cancel|${VERIFICATION}`, `sh1|home|not-a-uuid`, 'sh1|'])(
    'ignores an unreadable shipping payload %s without reading it as anything else',
    async (payload) => {
      const { service, shipping, changeRequests } = setup();
      await service.processIncomingOrThrow(tap(payload));
      expect(shipping.recordCustomerReply).not.toHaveBeenCalled();
      expect(changeRequests.applyCustomerAnswer).not.toHaveBeenCalled();
    },
  );

  it('sends no thank-you from the Akeed number while the switch is off', async () => {
    const { service, shipping, automation } = setup({ acknowledgment: false });
    await service.processIncomingOrThrow(tap(`sh1|home|${VERIFICATION}`));
    expect(shipping.recordCustomerReply).toHaveBeenCalled();
    expect(automation.enqueueShippingAcknowledgment).not.toHaveBeenCalled();
  });

  it('sends no thank-you when the store has not opted in', async () => {
    const { service, automation } = setup({ optedIn: false });
    await service.processIncomingOrThrow(tap(`sh1|home|${VERIFICATION}`));
    expect(automation.enqueueShippingAcknowledgment).not.toHaveBeenCalled();
  });
});
