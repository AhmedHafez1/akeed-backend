import { Injectable, Logger } from '@nestjs/common';
import { EasyOrdersConnectionsRepository } from '../../database/repositories/easyorders-connections.repository';
import type { PlatformType } from '../../../shared/interfaces/commerce-source.interface';
import {
  buildBackendLog,
  normalizeError,
} from '../../../shared/logging/backend-log.util';
import {
  currentDetailsOf,
  type CurrentOrderReadRequest,
  type CurrentOrderReadResult,
  type CurrentOrderSource,
} from '../../../shared/ports/current-order-source.port';
import { EASYORDERS_UNVERIFIED_MARKER } from './easyorders-ingestion.policy';
import { EasyOrdersOrderNormalizer } from './easyorders-order.normalizer';

/**
 * An EasyOrders order's current details. The normalizer reads the order back
 * from EasyOrders whenever a delivery is marked unverified, with the
 * integration's own key, inside its rate budget and with the store check; a
 * delivery that carries only the order and store ids makes it do exactly
 * that, so the details are the ones EasyOrders holds now.
 */
@Injectable()
export class EasyOrdersCurrentOrderSource implements CurrentOrderSource {
  readonly platform: PlatformType = 'easyorders';

  private readonly logger = new Logger(EasyOrdersCurrentOrderSource.name);

  constructor(
    private readonly connections: EasyOrdersConnectionsRepository,
    private readonly normalizer: EasyOrdersOrderNormalizer,
  ) {}

  async readCurrentOrder(
    request: CurrentOrderReadRequest,
  ): Promise<CurrentOrderReadResult> {
    try {
      const connection = await this.connections.findByIntegration(
        request.integrationId,
        request.orgId,
      );
      if (!connection || !connection.apiKeyEncrypted)
        return this.unavailable(
          request,
          'order_source_unavailable',
          'connection',
        );
      const normalized = await this.normalizer.normalizeOrder(
        {
          id: request.externalOrderId,
          store_id: connection.storeId,
          [EASYORDERS_UNVERIFIED_MARKER]: true,
        },
        request.integrationId,
        request.orgId,
      );
      if (normalized && 'skipped' in normalized)
        return this.unavailable(
          request,
          normalized.reason === 'order_not_found'
            ? 'order_not_found'
            : normalized.reason.startsWith('source_') ||
                normalized.reason.startsWith('store_')
              ? 'order_source_unavailable'
              : 'order_not_eligible',
          normalized.reason,
        );
      if (!normalized || normalized.externalOrderId !== request.externalOrderId)
        return this.unavailable(request, 'order_not_eligible', 'normalize');
      return { status: 'found', order: currentDetailsOf(normalized) };
    } catch (error) {
      // Rate budget, rate limit and an unavailable store are thrown as
      // "try again"; for a merchant's resend they are one retryable answer.
      this.logger.warn(
        buildBackendLog(EasyOrdersCurrentOrderSource.name, {
          action: 'easyorders-current-order-read',
          outcome: 'failure',
          orgId: request.orgId,
          integrationId: request.integrationId,
          ...normalizeError(error),
        }),
      );
      return { status: 'unavailable', code: 'order_source_unavailable' };
    }
  }

  private unavailable(
    request: CurrentOrderReadRequest,
    code: Extract<CurrentOrderReadResult, { status: 'unavailable' }>['code'],
    reason: string,
  ): CurrentOrderReadResult {
    this.logger.warn(
      buildBackendLog(EasyOrdersCurrentOrderSource.name, {
        action: 'easyorders-current-order-read',
        outcome: 'skipped',
        orgId: request.orgId,
        integrationId: request.integrationId,
        reason,
        code,
      }),
    );
    return { status: 'unavailable', code };
  }
}
