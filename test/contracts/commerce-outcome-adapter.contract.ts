import {
  COMMERCE_OUTCOME_ACTIONS,
  type CommerceOutcomeAction,
  type CommerceOutcomeAdapter,
  type CommerceOutcomeAdapterRequest,
  type CommerceOutcomeOperationResult,
} from '../../src/shared/commerce/commerce-outcome';
import type { PlatformType } from '../../src/shared/interfaces/commerce-source.interface';

interface AdapterContractFixture {
  adapter: CommerceOutcomeAdapter;
  request: CommerceOutcomeAdapterRequest;
}

interface AdapterContractOptions {
  name: string;
  platformType: PlatformType;
  capabilities: readonly CommerceOutcomeAction[];
  expectedStatus: Partial<
    Record<CommerceOutcomeAction, CommerceOutcomeOperationResult['status']>
  >;
  createFixture: (action: CommerceOutcomeAction) => AdapterContractFixture;
}

const operationStatuses = new Set<CommerceOutcomeOperationResult['status']>([
  'applied',
  'accepted_without_reference',
  'unsupported',
  'pending_provider_operation',
  'retryable_failure',
  'permanent_failure',
]);

/**
 * Shared provider-neutral checks for every current and future commerce outcome
 * adapter. Provider-specific HTTP payload and side-effect assertions belong in
 * the adapter's own describe block.
 */
export function defineCommerceOutcomeAdapterContract(
  options: AdapterContractOptions,
): void {
  describe(`${options.name} commerce outcome adapter contract`, () => {
    it('declares one known platform and only the expected capabilities', () => {
      const { adapter } = options.createFixture(options.capabilities[0]);

      expect(adapter.platformType).toBe(options.platformType);
      expect(typeof adapter.requiresActiveConnection).toBe('boolean');
      expect(adapter.capabilities.size).toBeGreaterThan(0);
      expect([...adapter.capabilities].sort()).toEqual(
        [...options.capabilities].sort(),
      );
      expect(
        [...adapter.capabilities].every((action) =>
          COMMERCE_OUTCOME_ACTIONS.includes(action),
        ),
      ).toBe(true);
    });

    it.each(options.capabilities)(
      'returns a valid neutral operation for advertised %s without mutating trusted identity',
      async (action) => {
        const { adapter, request } = options.createFixture(action);
        const originalRequest = structuredClone(request);

        const result = await adapter.execute(request);

        expect(request).toEqual(originalRequest);
        expect(operationStatuses.has(result.status)).toBe(true);
        expect(result.status).toBe(options.expectedStatus[action]);
        if (result.status === 'pending_provider_operation') {
          expect(result.providerOperationId.trim()).not.toBe('');
        }
        if (
          result.status === 'retryable_failure' ||
          result.status === 'permanent_failure'
        ) {
          expect(result.errorCode.trim()).not.toBe('');
        }
      },
    );
  });
}
