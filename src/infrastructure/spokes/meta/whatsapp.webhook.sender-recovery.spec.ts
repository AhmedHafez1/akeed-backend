import { WhatsAppWebhookService } from './whatsapp.webhook.service';
import { classifyOwnNumberFailure } from './own-number/own-number-send-failure.policy';

describe('merchant receipt integration', () => {
  function setup() {
    const dispatches = {
      recordMerchantReceipt: jest.fn().mockResolvedValue({
        dispatchId: 'dispatch',
        orgId: 'org',
        verificationId: 'verification',
      }),
      resolveOrParkReceipt: jest.fn(),
      recordProviderStatus: jest.fn(),
    };
    const verifications = {
      findById: jest.fn().mockResolvedValue({ status: 'no_whatsapp' }),
    };
    const hub = { markNoWhatsApp: jest.fn().mockResolvedValue(undefined) };
    const recovery = {
      enqueueRecovery: jest.fn().mockResolvedValue(undefined),
    };
    const service = new WhatsAppWebhookService(
      verifications as never,
      hub as never,
      dispatches as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      recovery as never,
    );
    return { service, dispatches, recovery, hub };
  }
  it.each([
    131026,
    131000,
    190,
    131042,
    131031,
    132015,
    100,
    999999,
    undefined,
  ])(
    'normalizes failed receipt %s before any legacy settlement',
    async (code) => {
      const s = setup();
      await s.service.processIncomingOrThrow({
        entry: [
          {
            id: 'waba',
            changes: [
              {
                field: 'messages',
                value: {
                  metadata: { phone_number_id: 'merchant-phone' },
                  statuses: [
                    {
                      id: 'wamid',
                      status: 'failed',
                      timestamp: '1793700000',
                      biz_opaque_callback_data: 'attempt',
                      errors: code === undefined ? [] : [{ code }],
                    },
                  ],
                },
              },
            ],
          },
        ],
      });
      expect(s.dispatches.recordMerchantReceipt).toHaveBeenCalledWith(
        expect.objectContaining({
          providerMessageId: 'wamid',
          attemptId: 'attempt',
          phoneNumberId: 'merchant-phone',
          wabaId: 'waba',
          failure: classifyOwnNumberFailure({ code }),
        }),
      );
      expect(s.dispatches.resolveOrParkReceipt).not.toHaveBeenCalled();
      expect(s.dispatches.recordProviderStatus).not.toHaveBeenCalled();
      expect(s.recovery.enqueueRecovery).toHaveBeenCalledWith(
        'org',
        'dispatch',
      );
    },
  );
  it('retains late sent acceptance for merchant attempts', async () => {
    const s = setup();
    await s.service.processIncomingOrThrow({
      entry: [
        {
          id: 'waba',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'merchant-phone' },
                statuses: [
                  {
                    id: 'late-wamid',
                    status: 'sent',
                    biz_opaque_callback_data: 'attempt',
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(s.dispatches.recordMerchantReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'sent',
        providerMessageId: 'late-wamid',
      }),
    );
    expect(s.dispatches.resolveOrParkReceipt).not.toHaveBeenCalled();
  });
});
