import { CommerceOutcomeRegistryService } from './commerce-outcome-registry.service';
import type { CommerceOutcomeAdapter } from '../../shared/commerce/commerce-outcome';

const command = {
  orgId: 'org-1',
  integrationId: 'int-1',
  externalOrderId: '1001',
  correlationId: 'ver-1',
  action: 'automatic_no_reply_cancellation' as const,
};

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    orgId: 'org-1',
    integrationId: 'int-1',
    externalOrderId: '1001',
    isTest: false,
    integration: {
      id: 'int-1',
      orgId: 'org-1',
      platformType: 'shopify',
      platformStoreUrl: 'shop.myshopify.com',
      accessToken: 'token',
      isActive: true,
      metadata: {},
    },
    ...overrides,
  };
}

/* eslint-disable @typescript-eslint/unbound-method -- jest.fn() fakes, never called unbound */

function setup(
  found: ReturnType<typeof order> | undefined,
  adapter: Partial<CommerceOutcomeAdapter> = {},
) {
  const full: CommerceOutcomeAdapter = {
    platformType: 'shopify',
    capabilities: new Set(['automatic_no_reply_cancellation']),
    requiresActiveConnection: true,
    execute: jest.fn(),
    inspectForCancellation: jest
      .fn()
      .mockResolvedValue({ state: 'cancellable' }),
    resolveOperation: jest.fn().mockResolvedValue({ state: 'done' }),
    ...adapter,
  };
  const registry = new CommerceOutcomeRegistryService(
    { findForOutcomeDispatch: jest.fn().mockResolvedValue(found) } as never,
    [full],
  );
  return { registry, adapter: full };
}

describe('CommerceOutcomeRegistryService inspection', () => {
  it('asks the adapter of the order’s own source', async () => {
    const { registry, adapter } = setup(order());
    await expect(registry.inspectForCancellation(command)).resolves.toEqual({
      state: 'cancellable',
    });
    expect(adapter.inspectForCancellation).toHaveBeenCalledWith(
      expect.objectContaining({ connection: order().integration }),
    );
  });

  it('fails closed on an order of another source or organization', async () => {
    const { registry, adapter } = setup(order({ orgId: 'org-2' }));
    await expect(registry.inspectForCancellation(command)).resolves.toEqual({
      state: 'permanent_failure',
      errorCode: 'source_identity_mismatch',
    });
    expect(adapter.inspectForCancellation).not.toHaveBeenCalled();
  });

  it('refuses an inactive source', async () => {
    const { registry } = setup(
      order({ integration: { ...order().integration, isActive: false } }),
    );
    await expect(registry.inspectForCancellation(command)).resolves.toEqual({
      state: 'permanent_failure',
      errorCode: 'integration_inactive',
    });
  });

  it('reports a source that cannot cancel automatically as unsupported', async () => {
    const { registry } = setup(order(), { capabilities: new Set() });
    await expect(registry.inspectForCancellation(command)).resolves.toEqual({
      state: 'unsupported',
      reason: 'capability_not_supported',
    });
  });

  it('never calls the store for a test order', async () => {
    const { registry, adapter } = setup(order({ isTest: true }));
    await expect(registry.inspectForCancellation(command)).resolves.toEqual({
      state: 'cancellable',
    });
    await expect(registry.resolveOperation(command, 'job-1')).resolves.toEqual({
      state: 'done',
    });
    expect(adapter.inspectForCancellation).not.toHaveBeenCalled();
    expect(adapter.resolveOperation).not.toHaveBeenCalled();
  });

  it('turns a thrown store read into a retryable failure', async () => {
    const { registry } = setup(order(), {
      inspectForCancellation: jest.fn().mockRejectedValue(new Error('boom')),
    });
    await expect(registry.inspectForCancellation(command)).resolves.toEqual({
      state: 'retryable_failure',
      errorCode: 'adapter_inspect_failed',
    });
  });
});
