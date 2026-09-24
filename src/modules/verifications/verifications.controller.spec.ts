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
    const user = { orgId: 'org-1', role: 'owner' } as never;
    await expect(controller.cancelNoReplyOrder(user, 'ver-1')).resolves.toEqual(
      {
        ...response,
        shopifyJobId: response.providerOperationId,
      },
    );
    expect(service.cancelNoReplyOrder).toHaveBeenCalledWith(user, 'ver-1');
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

  it.each([
    ['owner', true],
    ['admin', true],
    ['viewer', false],
  ])('publishes %s verification write permissions', async (role, allowed) => {
    const service = {
      listByOrg: jest.fn().mockResolvedValue({
        data: [],
        next_cursor: null,
        page_context: {
          source: { status: 'connected' },
          automation: {},
        },
      }),
    };
    const controller = new VerificationsController(
      service as never,
      {} as never,
    );

    await expect(
      controller.listVerifications({ orgId: 'org-1', role } as never, {}),
    ).resolves.toMatchObject({
      page_context: {
        permissions: {
          can_send_test_verification: allowed,
          can_cancel_orders: allowed,
          can_create_manual_order: allowed,
        },
      },
    });
    expect(service.listByOrg).toHaveBeenCalledWith('org-1', {});
  });
});

describe('Dashboard overview and manual confirmation routes', () => {
  it('scopes the overview to the authenticated org, never the query', async () => {
    const overview = { needs_action: { count: 0, items: [] } };
    const service = { getOverview: jest.fn().mockResolvedValue(overview) };
    const controller = new VerificationsController(
      service as never,
      {} as never,
    );
    const query = { date_range: 'last_7_days' as const };

    await expect(
      controller.getVerificationOverview(
        { orgId: 'org-1', role: 'viewer' } as never,
        query,
      ),
    ).resolves.toEqual({
      overview: { ...overview, permissions: { can_confirm_orders: false } },
    });
    expect(service.getOverview).toHaveBeenCalledWith('org-1', query);
  });

  it('hands the whole user to manual confirmation for the role check', async () => {
    const response = {
      success: true,
      verificationId: 'ver-1',
      status: 'confirmed',
    };
    const service = { confirmManually: jest.fn().mockResolvedValue(response) };
    const controller = new VerificationsController(
      service as never,
      {} as never,
    );
    const user = { orgId: 'org-1', role: 'owner' } as never;

    await expect(controller.confirmManually(user, 'ver-1')).resolves.toEqual(
      response,
    );
    expect(service.confirmManually).toHaveBeenCalledWith(user, 'ver-1');
  });
});
