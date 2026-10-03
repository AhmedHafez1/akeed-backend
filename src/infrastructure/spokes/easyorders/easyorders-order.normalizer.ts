import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EasyOrdersConnectionsRepository,
  type EasyOrdersConnection,
} from '../../database/repositories/easyorders-connections.repository';
import type {
  WebhookNormalizationResult,
  WebhookOrderNormalizer,
} from '../../../modules/webhook-queue/interfaces/webhook-normalizer.interface';
import { CANONICAL_TOTAL_PRICE_PATTERN } from '../../../shared/commerce/canonical-order.rules';
import { collectPaymentSignals } from '../../../shared/commerce/payment-signals';
import {
  RetryableProviderError,
  RetryAfterError,
} from '../../../shared/http/bounded-http';
import type { PlatformType } from '../../../shared/interfaces/commerce-source.interface';
import { buildBackendLog } from '../../../shared/logging/backend-log.util';
import { PhoneService } from '../../../shared/services/phone.service';
import { decryptToken } from '../../../shared/utils/token-encryption.util';
import { EasyOrdersApiClient } from './easyorders-api.client';
import {
  EasyOrdersRateLimiter,
  msUntilNextMinute,
} from './easyorders-rate-limiter';

/**
 * Why an EasyOrders order did not become an Akeed order. Recorded on the
 * event; none of them carries provider text or customer data.
 */
export type EasyOrdersSkipReason =
  | 'source_connection_missing'
  | 'store_mismatch'
  | 'store_unverified'
  | 'store_unavailable'
  | 'source_credentials_rejected'
  | 'order_not_found'
  | 'incomplete_payload'
  | 'missing_currency'
  | 'missing_phone_country'
  | 'invalid_phone'
  | 'invalid_amount';

/** An inactive store is a health state, retried slowly (section 2). */
const INACTIVE_STORE_RETRY_MS = 5 * 60_000;
const ORDER_NUMBER_LENGTH = 8;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** `total_cost` is a bare number; it is stored as decimal text. */
function toDecimalText(value: unknown): string | null {
  const amount =
    typeof value === 'number' && Number.isFinite(value)
      ? value.toFixed(2)
      : text(value);
  return CANONICAL_TOTAL_PRICE_PATTERN.test(amount) ? amount : null;
}

function hasAmount(value: unknown): boolean {
  return typeof value === 'number' || text(value) !== '';
}

/** The fields an order needs before it can be normalized at all. */
function isIncomplete(order: Record<string, unknown>): boolean {
  return (
    !hasAmount(order.total_cost) || !text(order.phone) || !text(order.full_name)
  );
}

/**
 * Turns an EasyOrders order into a `NormalizedOrder` (US-06-03, contract
 * record sections 2, 4 and 8).
 *
 * Currency and phone country come from the integration's own settings, never
 * from the payload or a guess. The order is read back from EasyOrders only
 * when the webhook lacks a field or the store is still an unverified claim,
 * always with this integration's key and inside its rate budget.
 */
@Injectable()
export class EasyOrdersOrderNormalizer implements WebhookOrderNormalizer {
  readonly platform: PlatformType = 'easyorders';

  private readonly logger = new Logger(EasyOrdersOrderNormalizer.name);

  constructor(
    private readonly connections: EasyOrdersConnectionsRepository,
    private readonly api: EasyOrdersApiClient,
    private readonly limiter: EasyOrdersRateLimiter,
    private readonly phones: PhoneService,
    private readonly config: ConfigService,
  ) {}

  async normalizeOrder(
    rawPayload: Record<string, unknown>,
    integrationId: string,
    orgId: string,
  ): Promise<WebhookNormalizationResult> {
    const connection = await this.connections.findByIntegration(
      integrationId,
      orgId,
    );
    if (!connection)
      return this.skip(orgId, integrationId, 'source_connection_missing');
    if (rawPayload.store_id !== connection.storeId)
      return this.skip(orgId, integrationId, 'store_mismatch');

    const orderId = text(rawPayload.id);
    let order = rawPayload;
    if (
      !orderId ||
      isIncomplete(rawPayload) ||
      !text(rawPayload.payment_method) ||
      connection.storeVerifiedAt === null
    ) {
      if (!orderId)
        return this.skip(orgId, integrationId, 'incomplete_payload');
      const fetched = await this.lookup(connection, orderId);
      if ('skipped' in fetched) return fetched;
      order = fillMissing(rawPayload, fetched.order);
    }

    if (isIncomplete(order))
      return this.skip(orgId, integrationId, 'incomplete_payload');
    if (!connection.currency)
      return this.skip(orgId, integrationId, 'missing_currency');
    if (!connection.phoneCountry)
      return this.skip(orgId, integrationId, 'missing_phone_country');

    const phone = this.phones.standardizeMobile(
      text(order.phone),
      connection.phoneCountry,
    );
    if (!phone.ok) return this.skip(orgId, integrationId, 'invalid_phone');
    const totalPrice = toDecimalText(order.total_cost);
    if (!totalPrice) return this.skip(orgId, integrationId, 'invalid_amount');

    const paymentMethod = text(order.payment_method);
    return {
      orgId,
      integrationId,
      externalOrderId: orderId,
      // The payload has no merchant-facing reference; the start of the id is
      // what the seller sees in the EasyOrders order list.
      orderNumber: orderId.slice(0, ORDER_NUMBER_LENGTH),
      customerPhone: phone.e164,
      customerName: text(order.full_name),
      totalPrice,
      currency: connection.currency,
      paymentMethod,
      paymentSignals: collectPaymentSignals(undefined, paymentMethod),
      rawPayload,
    };
  }

  /**
   * One read of the order, with the integration's own key. A store id that
   * matches turns the store claim into a verified one; anything else stops
   * the order. Throws for whatever should be tried again.
   */
  private async lookup(
    connection: EasyOrdersConnection,
    orderId: string,
  ): Promise<
    | { order: Record<string, unknown> }
    | { skipped: true; reason: EasyOrdersSkipReason }
  > {
    const { integrationId, orgId } = connection;
    const budget = this.limiter.acquire(integrationId, 'lookup');
    if (!budget.allowed)
      throw new RetryAfterError(
        'source_rate_budget_exhausted',
        budget.retryAfterMs,
      );

    const result = await this.api.getOrder(
      decryptToken(
        connection.apiKeyEncrypted,
        this.config.getOrThrow<string>('SHOPIFY_TOKEN_ENCRYPTION_KEY'),
      ),
      orderId,
    );
    this.logger.log(
      buildBackendLog(EasyOrdersOrderNormalizer.name, {
        action: 'easyorders-order-lookup',
        outcome: result.kind === 'found' ? 'success' : 'failure',
        orgId,
        integrationId,
        lookupResult: result.kind,
      }),
    );

    switch (result.kind) {
      case 'rate_limited': {
        const delayMs = result.retryAfterMs ?? msUntilNextMinute(Date.now());
        this.limiter.pause(integrationId, delayMs);
        throw new RetryAfterError('source_rate_limited', delayMs);
      }
      case 'unavailable':
        throw new RetryableProviderError('source_unavailable');
      case 'store_inactive':
        await this.connections.setHealth(
          integrationId,
          orgId,
          'store_inactive',
        );
        throw new RetryAfterError(
          'source_store_inactive',
          INACTIVE_STORE_RETRY_MS,
        );
      case 'credentials_rejected':
        await this.connections.setHealth(
          integrationId,
          orgId,
          'credentials_rejected',
        );
        return this.skip(orgId, integrationId, 'source_credentials_rejected');
      case 'not_found':
        return this.skip(orgId, integrationId, 'order_not_found');
      case 'found':
        break;
    }

    if (connection.health !== 'ok')
      await this.connections.setHealth(integrationId, orgId, 'ok');
    // Data read with the stored key must name the same store, or the claim
    // is not proven and nothing is taken from the response.
    if (typeof result.order.store_id !== 'string')
      return this.skip(orgId, integrationId, 'store_unverified');
    if (result.order.store_id !== connection.storeId)
      return this.skip(orgId, integrationId, 'store_mismatch');
    if (
      connection.storeVerifiedAt === null &&
      (await this.connections.markStoreVerified(
        integrationId,
        orgId,
        connection.storeId,
      )) === 'taken'
    )
      return this.skip(orgId, integrationId, 'store_unavailable');
    return { order: result.order };
  }

  private skip(
    orgId: string,
    integrationId: string,
    reason: EasyOrdersSkipReason,
  ): { skipped: true; reason: EasyOrdersSkipReason } {
    this.logger.warn(
      buildBackendLog(EasyOrdersOrderNormalizer.name, {
        action: 'easyorders-order-normalize',
        outcome: 'skipped',
        orgId,
        integrationId,
        reason,
      }),
    );
    return { skipped: true, reason };
  }
}

/** The webhook wins; the fetched order only supplies what it lacks. */
function fillMissing(
  payload: Record<string, unknown>,
  fetched: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...payload };
  for (const field of ['total_cost', 'phone', 'full_name', 'payment_method'])
    if (
      (field === 'total_cost'
        ? !hasAmount(merged[field])
        : !text(merged[field])) &&
      fetched[field] !== undefined
    )
      merged[field] = fetched[field];
  return merged;
}
