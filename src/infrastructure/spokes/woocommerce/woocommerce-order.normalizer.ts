import { Injectable, Logger } from '@nestjs/common';
import { WooCommerceConnectionsRepository } from '../../database/repositories/woocommerce-connections.repository';
import type {
  WebhookNormalizationResult,
  WebhookOrderNormalizer,
} from '../../../modules/webhook-queue/interfaces/webhook-normalizer.interface';
import {
  CANONICAL_NAME_MAX_LENGTH,
  CANONICAL_TOTAL_PRICE_PATTERN,
  fitsCanonicalOrderNumber,
  isCanonicalCurrency,
} from '../../../shared/commerce/canonical-order.rules';
import { collectPaymentSignals } from '../../../shared/commerce/payment-signals';
import type { PlatformType } from '../../../shared/interfaces/commerce-source.interface';
import { buildBackendLog } from '../../../shared/logging/backend-log.util';
import { PhoneService } from '../../../shared/services/phone.service';
import { isRecord, readStoredWooCommerceOrder } from './woocommerce-delivery';
import {
  evaluateWooCommerceStart,
  readWooCommerceOrderId,
  type WooCommerceStartSkipReason,
} from './woocommerce-ingestion.policy';

/**
 * Why a WooCommerce delivery did not become an Akeed order. Recorded on the
 * event; none of them carries provider text or customer data.
 */
export type WooCommerceSkipReason =
  | WooCommerceStartSkipReason
  | 'source_connection_missing'
  | 'incomplete_payload'
  | 'missing_currency'
  | 'missing_phone_country'
  | 'invalid_phone'
  | 'invalid_amount';

const PHONE_PUNCTUATION = /[\s\-.()/]+/g;
/** `+` or `00`: the number names its own country. */
const INTERNATIONAL_PREFIX = /^(\+|00)/;
const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Turns a stored WooCommerce delivery into a `NormalizedOrder` (US-07-03,
 * contract record section 4).
 *
 * Everything comes from the order itself: currency, total and the billing
 * country that a local phone number is read in. Nothing is looked up at the
 * store and nothing is guessed; a value that is missing or does not parse is
 * a recorded reason.
 */
@Injectable()
export class WooCommerceOrderNormalizer implements WebhookOrderNormalizer {
  readonly platform: PlatformType = 'woocommerce';

  private readonly logger = new Logger(WooCommerceOrderNormalizer.name);

  constructor(
    private readonly connections: WooCommerceConnectionsRepository,
    private readonly phones: PhoneService,
  ) {}

  async normalizeOrder(
    rawPayload: Record<string, unknown>,
    integrationId: string,
    orgId: string,
  ): Promise<WebhookNormalizationResult> {
    const order = readStoredWooCommerceOrder(rawPayload);
    const externalOrderId = order ? readWooCommerceOrderId(order.id) : null;
    if (!order || !externalOrderId)
      return this.skip(orgId, integrationId, 'incomplete_payload');

    const connection = await this.connections.findByIntegration(
      integrationId,
      orgId,
    );
    if (!connection)
      return this.skip(orgId, integrationId, 'source_connection_missing');

    // The rule the webhook service routed by, so a draft, a non-COD order and
    // an order older than the connection are recorded with their reason.
    const decision = evaluateWooCommerceStart(order, connection.connectedAt);
    if (!decision.start)
      return this.skip(orgId, integrationId, decision.reason);

    const billing = isRecord(order.billing) ? order.billing : {};
    const phoneText = text(billing.phone);
    if (!phoneText)
      return this.skip(orgId, integrationId, 'incomplete_payload');
    const currency = text(order.currency).toUpperCase();
    if (!isCanonicalCurrency(currency))
      return this.skip(orgId, integrationId, 'missing_currency');

    const country = text(billing.country).toUpperCase();
    const hasCountry = COUNTRY_CODE_PATTERN.test(country);
    const international = INTERNATIONAL_PREFIX.test(
      phoneText.replace(PHONE_PUNCTUATION, ''),
    );
    if (!international && !hasCountry)
      return this.skip(orgId, integrationId, 'missing_phone_country');
    const phone = this.phones.standardizeMobile(
      phoneText,
      hasCountry ? country : '',
    );
    if (!phone.ok) return this.skip(orgId, integrationId, 'invalid_phone');

    const totalPrice = text(order.total);
    if (!CANONICAL_TOTAL_PRICE_PATTERN.test(totalPrice))
      return this.skip(orgId, integrationId, 'invalid_amount');

    const orderNumber = text(order.number);
    const customerName = [text(billing.first_name), text(billing.last_name)]
      .filter(Boolean)
      .join(' ')
      .slice(0, CANONICAL_NAME_MAX_LENGTH)
      .trim();
    const paymentMethod = text(order.payment_method);
    return {
      orgId,
      integrationId,
      externalOrderId,
      ...(orderNumber && fitsCanonicalOrderNumber(orderNumber)
        ? { orderNumber }
        : {}),
      customerPhone: phone.e164,
      ...(customerName ? { customerName } : {}),
      totalPrice,
      currency,
      paymentMethod,
      paymentSignals: collectPaymentSignals(undefined, paymentMethod),
      codStatus: 'cod',
      rawPayload: order,
    };
  }

  private skip(
    orgId: string,
    integrationId: string,
    reason: WooCommerceSkipReason,
  ): { skipped: true; reason: WooCommerceSkipReason } {
    this.logger.warn(
      buildBackendLog(WooCommerceOrderNormalizer.name, {
        action: 'woocommerce-order-normalize',
        outcome: 'skipped',
        orgId,
        integrationId,
        reason,
      }),
    );
    return { skipped: true, reason };
  }
}
