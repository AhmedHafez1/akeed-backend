import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WooCommerceConnectionsRepository } from '../../database/repositories/woocommerce-connections.repository';
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
import { WooCommerceApiClient } from './woocommerce-api.client';
import { readWooCommerceCredentials } from './woocommerce-credentials';
import { WooCommerceOrderNormalizer } from './woocommerce-order.normalizer';

/**
 * A WooCommerce order's current details: one read of the order with the
 * connection's own keys, turned into Akeed's order by the same normalizer
 * as a delivered webhook, so its phone, amount and items follow the same
 * rules.
 */
@Injectable()
export class WooCommerceCurrentOrderSource implements CurrentOrderSource {
  readonly platform: PlatformType = 'woocommerce';

  private readonly logger = new Logger(WooCommerceCurrentOrderSource.name);

  constructor(
    private readonly connections: WooCommerceConnectionsRepository,
    private readonly api: WooCommerceApiClient,
    private readonly normalizer: WooCommerceOrderNormalizer,
    private readonly config: ConfigService,
  ) {}

  async readCurrentOrder(
    request: CurrentOrderReadRequest,
  ): Promise<CurrentOrderReadResult> {
    try {
      const connection = await this.connections.findByIntegration(
        request.integrationId,
        request.orgId,
      );
      if (!connection || connection.disconnectedAt)
        return this.unavailable(
          request,
          'order_source_unavailable',
          'connection',
        );
      const credentials = readWooCommerceCredentials(
        connection,
        this.config.getOrThrow<string>('SHOPIFY_TOKEN_ENCRYPTION_KEY'),
      );
      if (!credentials)
        return this.unavailable(
          request,
          'order_source_unavailable',
          'credentials',
        );
      const read = await this.api.getOrderDetails(
        connection.storeUrl,
        credentials,
        request.externalOrderId,
      );
      if (read.kind === 'not_found')
        return this.unavailable(request, 'order_not_found', read.kind);
      if (read.kind !== 'found')
        return this.unavailable(request, 'order_source_unavailable', read.kind);
      const normalized = await this.normalizer.normalizeOrder(
        { order: read.payload },
        request.integrationId,
        request.orgId,
      );
      if (
        !normalized ||
        'skipped' in normalized ||
        normalized.externalOrderId !== request.externalOrderId
      )
        return this.unavailable(request, 'order_not_eligible', 'normalize');
      return { status: 'found', order: currentDetailsOf(normalized) };
    } catch (error) {
      this.logger.warn(
        buildBackendLog(WooCommerceCurrentOrderSource.name, {
          action: 'woocommerce-current-order-read',
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
      buildBackendLog(WooCommerceCurrentOrderSource.name, {
        action: 'woocommerce-current-order-read',
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
