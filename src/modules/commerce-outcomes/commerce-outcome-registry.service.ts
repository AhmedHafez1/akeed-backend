import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { OrdersRepository } from '../../infrastructure/database/repositories/orders.repository';
import {
  COMMERCE_OUTCOME_ADAPTERS,
  type CommerceOutcomeAction,
  type CommerceOutcomeAdapter,
  type CommerceOutcomeDispatchCommand,
  type CommerceOutcomeDispatchResult,
  type CommerceOutcomeOperationResult,
} from '../../shared/commerce/commerce-outcome';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import { isSyntheticOrder } from '../../shared/commerce/synthetic-order';
import { CommerceOutcomeSyncTracker } from './commerce-outcome-sync-tracker.service';

@Injectable()
export class CommerceOutcomeRegistryService {
  private readonly logger = new Logger(CommerceOutcomeRegistryService.name);
  private readonly adaptersByPlatform: ReadonlyMap<
    string,
    CommerceOutcomeAdapter
  >;

  constructor(
    private readonly ordersRepository: OrdersRepository,
    @Inject(COMMERCE_OUTCOME_ADAPTERS)
    adapters: readonly CommerceOutcomeAdapter[],
    // Absent where nothing tracks synchronization; dispatch is then exactly
    // what it was before sync states existed.
    @Optional() private readonly tracker?: CommerceOutcomeSyncTracker,
  ) {
    const adaptersByPlatform = new Map<string, CommerceOutcomeAdapter>();
    for (const adapter of adapters) {
      if (adaptersByPlatform.has(adapter.platformType)) {
        throw new Error(
          `Duplicate commerce outcome adapter for ${adapter.platformType}`,
        );
      }
      adaptersByPlatform.set(adapter.platformType, adapter);
    }
    this.adaptersByPlatform = adaptersByPlatform;
  }

  supports(platformType: string, action: CommerceOutcomeAction): boolean {
    return (
      this.adaptersByPlatform.get(platformType)?.capabilities.has(action) ??
      false
    );
  }

  async dispatch(
    command: CommerceOutcomeDispatchCommand,
  ): Promise<CommerceOutcomeDispatchResult> {
    const order = await this.ordersRepository.findForOutcomeDispatch(command);

    if (
      !order ||
      order.orgId !== command.orgId ||
      order.integrationId !== command.integrationId ||
      order.externalOrderId !== command.externalOrderId ||
      !order.integration ||
      order.integration.id !== command.integrationId ||
      order.integration.orgId !== command.orgId
    ) {
      return this.complete(command, {
        status: 'permanent_failure',
        errorCode: 'source_identity_mismatch',
      });
    }

    const adapter = this.adaptersByPlatform.get(order.integration.platformType);
    const tracker =
      adapter?.tracksSynchronization === true && !isSyntheticOrder(order)
        ? this.tracker
        : undefined;

    if (
      order.integration.isActive !== true &&
      (adapter?.requiresActiveConnection ?? true)
    ) {
      const inactive: CommerceOutcomeOperationResult = {
        status: 'permanent_failure',
        errorCode: 'integration_inactive',
      };
      await tracker?.recordWithoutAttempt(command, order.id, inactive);
      return this.complete(command, inactive);
    }

    if (!adapter) {
      return this.complete(command, {
        status: 'unsupported',
        reason: 'adapter_not_registered',
      });
    }

    if (!adapter.capabilities.has(command.action)) {
      const unsupported: CommerceOutcomeOperationResult = {
        status: 'unsupported',
        reason: 'capability_not_supported',
      };
      await tracker?.recordWithoutAttempt(command, order.id, unsupported);
      return this.complete(command, unsupported);
    }

    if (isSyntheticOrder(order)) {
      return this.complete(command, { status: 'applied' });
    }

    const sync = await tracker?.begin(command, order.id);
    try {
      const result = await adapter.execute({
        ...command,
        connection: order.integration,
      });
      await tracker?.settle(sync, command, result);
      return this.complete(command, result);
    } catch (error: unknown) {
      this.logger.error(
        buildBackendLog(CommerceOutcomeRegistryService.name, {
          action: 'commerce-outcome-adapter-execute',
          outcome: 'failure',
          orgId: command.orgId,
          integrationId: command.integrationId,
          orderId: command.externalOrderId,
          commerceAction: command.action,
          correlationId: command.correlationId,
          platformType: order.integration.platformType,
          synchronizationState: 'retryable_failure',
          ...normalizeError(error),
        }),
      );
      const failed: CommerceOutcomeOperationResult = {
        status: 'retryable_failure',
        errorCode: 'adapter_execution_failed',
      };
      await tracker?.settle(sync, command, failed);
      return this.complete(command, failed);
    }
  }

  private complete(
    command: CommerceOutcomeDispatchCommand,
    operation: CommerceOutcomeOperationResult,
  ): CommerceOutcomeDispatchResult {
    const outcome =
      operation.status === 'applied' ||
      operation.status === 'accepted_without_reference'
        ? 'success'
        : operation.status === 'unsupported'
          ? 'skipped'
          : operation.status === 'pending_provider_operation' ||
              operation.status === 'retryable_failure'
            ? 'retry'
            : 'failure';

    this.logger.log(
      buildBackendLog(CommerceOutcomeRegistryService.name, {
        action: 'commerce-outcome-dispatch',
        outcome,
        orgId: command.orgId,
        integrationId: command.integrationId,
        orderId: command.externalOrderId,
        commerceAction: command.action,
        correlationId: command.correlationId,
        synchronizationState: operation.status,
        providerOperationId:
          operation.status === 'pending_provider_operation'
            ? operation.providerOperationId
            : undefined,
        reason:
          operation.status === 'unsupported' ? operation.reason : undefined,
        errorCode:
          operation.status === 'retryable_failure' ||
          operation.status === 'permanent_failure'
            ? operation.errorCode
            : undefined,
      }),
    );

    return { ...command, ...operation };
  }
}
