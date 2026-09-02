import { VerificationsController } from './verifications.controller';

describe('Cancellation response compatibility bridge', () => {
  it('returns the neutral operation and legacy alias together for non-atomic deployments', async () => {
    const response = {
      success: true,
      verificationId: 'ver-1',
      status: 'canceled',
      providerOperationId: 'gid://shopify/Job/42',
      operation: {
        status: 'pending_provider_operation',
        providerOperationId: 'gid://shopify/Job/42',
      },
    };
    const service = {
      cancelNoReplyOrder: jest.fn().mockResolvedValue(response),
    };
    const controller = new VerificationsController(
      service as never,
      {} as never,
    );
    await expect(
      controller.cancelNoReplyOrder({ orgId: 'org-1' } as never, 'ver-1'),
    ).resolves.toEqual({
      ...response,
      shopifyJobId: response.providerOperationId,
    });
    expect(service.cancelNoReplyOrder).toHaveBeenCalledWith('org-1', 'ver-1');
  });

  it('does not invent a provider reference for historical cancellations', async () => {
    const response = {
      success: true,
      verificationId: 'ver-1',
      status: 'canceled',
      alreadyCanceled: true,
    };
    const controller = new VerificationsController(
      { cancelNoReplyOrder: jest.fn().mockResolvedValue(response) } as never,
      {} as never,
    );
    await expect(
      controller.cancelNoReplyOrder({ orgId: 'org-1' } as never, 'ver-1'),
    ).resolves.toEqual(response);
  });
});
