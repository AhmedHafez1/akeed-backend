import { CommerceOutcomeRegistryService } from './commerce-outcome-registry.service';
import type { OrdersRepository } from '../../infrastructure/database/repositories/orders.repository';
import type {
  CommerceOutcomeAction,
  CommerceOutcomeAdapter,
  CommerceOutcomeAdapterRequest,
  CommerceOutcomeDispatchCommand,
  CommerceOutcomeOperationResult,
} from '../../shared/commerce/commerce-outcome';
import type { PlatformType } from '../../shared/interfaces/commerce-source.interface';

const command: CommerceOutcomeDispatchCommand = {
  orgId: 'org-1',
  integrationId: 'integration-1',
  externalOrderId: 'order-1',
  action: 'customer_confirmation',
  correlationId: 'verification-1',
};

function buildOrder(
  overrides: Record<string, unknown> = {},
  integrationOverrides: Record<string, unknown> = {},
) {
  return {
    id: 'local-order-1',
    orgId: command.orgId,
    integrationId: command.integrationId,
    externalOrderId: command.externalOrderId,
    integration: {
      id: command.integrationId,
      orgId: command.orgId,
      platformType: 'shopify',
      platformStoreUrl: 'merchant.myshopify.com',
      accessToken: 'encrypted-token',
      isActive: true,
      metadata: {},
      ...integrationOverrides,
    },
    ...overrides,
  };
}

function buildAdapter(
  platformType: PlatformType,
  capabilities: CommerceOutcomeAction[] = [command.action],
  result: CommerceOutcomeOperationResult = { status: 'applied' },
): CommerceOutcomeAdapter & {
  execute: jest.Mock<
    Promise<CommerceOutcomeOperationResult>,
    [CommerceOutcomeAdapterRequest]
  >;
} {
  return {
    platformType,
    capabilities: new Set(capabilities),
    execute: jest.fn().mockResolvedValue(result),
  };
}

describe('CommerceOutcomeRegistryService', () => {
  let findForOutcomeDispatch: jest.Mock;

  beforeEach(() => {
    findForOutcomeDispatch = jest.fn().mockResolvedValue(buildOrder());
  });

  function createService(adapters: CommerceOutcomeAdapter[]) {
    return new CommerceOutcomeRegistryService(
      { findForOutcomeDispatch } as unknown as OrdersRepository,
      adapters,
    );
  }

  it.each<{
    platformType: PlatformType;
    otherPlatformType: PlatformType;
  }>([
    { platformType: 'shopify', otherPlatformType: 'standalone' },
    { platformType: 'standalone', otherPlatformType: 'shopify' },
  ])(
    'selects the $platformType adapter from the persisted integration',
    async ({ platformType, otherPlatformType }) => {
      findForOutcomeDispatch.mockResolvedValue(
        buildOrder({}, { platformType }),
      );
      const selected = buildAdapter(platformType);
      const other = buildAdapter(otherPlatformType);

      const result = await createService([other, selected]).dispatch(command);

      expect(findForOutcomeDispatch).toHaveBeenCalledWith(command);
      expect(result).toEqual({ ...command, status: 'applied' });
      expect(selected.execute).toHaveBeenCalledTimes(1);
      expect(selected.execute.mock.calls[0][0].connection.platformType).toBe(
        platformType,
      );
      expect(selected.execute.mock.calls[0][0]).toMatchObject(command);
      expect(other.execute).not.toHaveBeenCalled();
    },
  );

  it('returns an explicit unsupported result when no adapter is registered', async () => {
    findForOutcomeDispatch.mockResolvedValue(
      buildOrder({}, { platformType: 'unknown-platform' }),
    );
    const adapter = buildAdapter('shopify');

    const result = await createService([adapter]).dispatch(command);

    expect(result).toEqual({
      ...command,
      status: 'unsupported',
      reason: 'adapter_not_registered',
    });
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it('returns an explicit unsupported result without calling an incapable adapter', async () => {
    const adapter = buildAdapter('shopify', ['automatic_no_reply_tagging']);

    const result = await createService([adapter]).dispatch(command);

    expect(result).toEqual({
      ...command,
      status: 'unsupported',
      reason: 'capability_not_supported',
    });
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it.each<CommerceOutcomeAction>([
    'customer_confirmation',
    'customer_cancellation',
    'merchant_no_reply_cancellation',
    'automatic_no_reply_tagging',
  ])('dispatches the %s contract when supported', async (action) => {
    const actionCommand = { ...command, action };
    const adapter = buildAdapter('shopify', [action]);

    const result = await createService([adapter]).dispatch(actionCommand);

    expect(result).toEqual({ ...actionCommand, status: 'applied' });
    expect(adapter.execute).toHaveBeenCalledTimes(1);
    expect(adapter.execute.mock.calls[0][0].connection.id).toBe(
      command.integrationId,
    );
    expect(adapter.execute.mock.calls[0][0]).toMatchObject(actionCommand);
  });

  it.each([
    { status: 'applied' } as const,
    {
      status: 'pending_provider_operation',
      providerOperationId: 'provider-operation-1',
    } as const,
    { status: 'retryable_failure', errorCode: 'provider_busy' } as const,
    { status: 'permanent_failure', errorCode: 'order_closed' } as const,
  ])('preserves the typed $status adapter result', async (operation) => {
    const result = await createService([
      buildAdapter('shopify', [command.action], operation),
    ]).dispatch(command);

    expect(result).toEqual({ ...command, ...operation });
  });

  it.each([
    ['missing source tuple', undefined],
    ['cross-tenant integration', buildOrder({}, { orgId: 'other-org' })],
    [
      'mismatched order integration',
      buildOrder({ integrationId: 'other-integration' }),
    ],
    [
      'mismatched external order',
      buildOrder({ externalOrderId: 'other-order' }),
    ],
  ])('rejects %s without an outbound commerce call', async (_label, order) => {
    findForOutcomeDispatch.mockResolvedValue(order);
    const adapter = buildAdapter('shopify');

    const result = await createService([adapter]).dispatch(command);

    expect(result).toEqual({
      ...command,
      status: 'permanent_failure',
      errorCode: 'source_identity_mismatch',
    });
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it('rejects an inactive integration without an outbound commerce call', async () => {
    findForOutcomeDispatch.mockResolvedValue(
      buildOrder({}, { isActive: false }),
    );
    const adapter = buildAdapter('shopify');

    const result = await createService([adapter]).dispatch(command);

    expect(result).toEqual({
      ...command,
      status: 'permanent_failure',
      errorCode: 'integration_inactive',
    });
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it('turns an unexpected adapter exception into a retryable failure', async () => {
    const adapter = buildAdapter('shopify');
    adapter.execute.mockRejectedValue(new Error('temporary provider error'));

    const result = await createService([adapter]).dispatch(command);

    expect(result).toEqual({
      ...command,
      status: 'retryable_failure',
      errorCode: 'adapter_execution_failed',
    });
  });

  it('rejects duplicate adapters for the same platform at startup', () => {
    expect(() =>
      createService([buildAdapter('shopify'), buildAdapter('shopify')]),
    ).toThrow('Duplicate commerce outcome adapter for shopify');
  });
});
