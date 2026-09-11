import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { isAxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';
import {
  buildBackendLog,
  normalizeError,
} from '../../../shared/logging/backend-log.util';
import {
  paymobIntegrationIds,
  readStandaloneCreditBillingConfig,
} from '../../../shared/config/standalone-credit-billing.config';
import {
  boundedCall,
  NO_RETRY,
  RetryableProviderError,
  type RetryPolicy,
} from '../../../shared/http/bounded-http';
import type {
  CheckoutResult,
  CreateCheckoutInput,
  NormalizedProviderEvent,
  PaymentInquiryResult,
  PaymentReference,
  PaymentsPort,
  PurchaseStatus,
} from '../../../shared/ports/payments.port';
import {
  mapPaymobCallback,
  PAYMOB_PROVIDER,
  paymobSignal,
} from './paymob-status.mapper';

/** One provider call must not outlive the merchant's patience. */
const REQUEST_TIMEOUT_MS = 12_000;

/**
 * Reading is safe to repeat; creating an intention is not. The inquiry policy
 * exists precisely so a lost checkout response can be resolved without ever
 * issuing a second intention.
 */
const INQUIRY_RETRY: RetryPolicy = {
  attempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 2_000,
  totalDeadlineMs: 20_000,
};

/**
 * Billing details Paymob requires but Akeed has no business collecting.
 *
 * The purchase is a merchant self-service top-up, not a consumer order, so
 * there is no shipping, no customer and no reason to hand a payment processor
 * personal data. Paymob rejects an absent block, so it gets its own placeholder.
 */
const BILLING_PLACEHOLDER = {
  first_name: 'Akeed',
  last_name: 'Merchant',
  email: 'billing@akeed.app',
  phone_number: '+201000000000',
  country: 'EG',
  city: 'NA',
  state: 'NA',
  street: 'NA',
  building: 'NA',
  floor: 'NA',
  apartment: 'NA',
  postal_code: 'NA',
} as const;

interface IntentionResponse {
  id?: unknown;
  client_secret?: unknown;
  intention_order_id?: unknown;
  special_reference?: unknown;
  payment_keys?: unknown;
}

/**
 * Paymob reads a number in `payment_methods` as an integration id and a string
 * as an integration name, so `"5911539"` finds nothing. Configuration keeps ids
 * as strings (and guarantees digit-only ones are safe integers); only the wire
 * format turns them back into numbers.
 */
function paymentMethod(integration: string): number | string {
  return /^\d+$/.test(integration) ? Number(integration) : integration;
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/**
 * The only class that knows Paymob's HTTP surface.
 *
 * It never touches the database, the credit ledger or a request principal:
 * everything it needs arrives as trusted values the billing module already
 * derived, and everything it returns is a provider-neutral result.
 */
@Injectable()
export class PaymobPaymentsAdapter implements PaymentsPort {
  private readonly logger = new Logger(PaymobPaymentsAdapter.name);

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  private settings() {
    const billing = readStandaloneCreditBillingConfig(this.config);
    if (!billing.enabled)
      throw new Error('Paymob is not configured; credit billing is disabled');
    return billing.paymob;
  }

  /**
   * Creates a payment intention and returns its Unified Checkout URL.
   *
   * Exactly one HTTP attempt, always. A timeout here means the intention may
   * exist; retrying would risk a second one for the same purchase, so the
   * outcome is reported as `unknown` and resolved by inquiry instead.
   */
  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutResult> {
    const paymob = this.settings();
    const redirectionUrl = new URL(paymob.returnUrl);
    redirectionUrl.searchParams.set('purchaseRef', input.reference);
    const body = {
      amount: input.totalMinor,
      currency: input.currency,
      payment_methods: paymobIntegrationIds(paymob).map(paymentMethod),
      special_reference: input.reference,
      expiration: paymob.checkoutExpirationSeconds,
      notification_url: paymob.callbackUrl,
      redirection_url: redirectionUrl.toString(),
      billing_data: BILLING_PLACEHOLDER,
      items: [
        {
          name: 'Akeed message credits',
          amount: input.unitPriceMinor,
          quantity: input.quantity,
        },
      ],
    };

    try {
      const response = await boundedCall(
        () =>
          firstValueFrom(
            this.http.post<IntentionResponse>(
              this.url('/v1/intention/'),
              body,
              {
                headers: {
                  Authorization: `Token ${paymob.secretKey}`,
                  'Content-Type': 'application/json',
                },
                timeout: REQUEST_TIMEOUT_MS,
              },
            ),
          ),
        { policy: NO_RETRY },
      );
      return this.readIntention(input, response.data);
    } catch (error) {
      return this.classify('createCheckout', input.reference, error);
    }
  }

  /**
   * Asks Paymob what actually happened to a reference.
   *
   * This is the recovery path for a checkout whose response was lost and for a
   * purchase whose callback never arrived, so it is the one call that retries.
   */
  async inquire(input: PaymentReference): Promise<PaymentInquiryResult> {
    const paymob = this.settings();
    try {
      const response = await boundedCall(
        () =>
          firstValueFrom(
            this.http.post<{ transaction?: unknown }>(
              this.url('/api/ecommerce/orders/transaction_inquiry'),
              {
                merchant_order_id: input.reference,
                ...(input.providerOrderId
                  ? { order_id: input.providerOrderId }
                  : {}),
              },
              {
                headers: {
                  Authorization: `Token ${paymob.secretKey}`,
                  'Content-Type': 'application/json',
                },
                timeout: REQUEST_TIMEOUT_MS,
              },
            ),
          ).catch((error: unknown) => {
            // A 5xx or a timeout is worth asking again; a definitive answer is
            // not, and a 404 is itself an answer.
            if (retryable(error)) throw new RetryableProviderError('provider');
            throw error;
          }),
        { policy: INQUIRY_RETRY },
      );
      return this.readInquiry(input, response.data);
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 404)
        return { outcome: 'not_found', code: 'not_found' };
      this.logFailure('inquire', input.reference, error);
      return { outcome: 'unknown', code: 'provider_unavailable' };
    }
  }

  private url(path: string): string {
    return new URL(path, this.settings().baseUrl).toString();
  }

  private readIntention(
    input: CreateCheckoutInput,
    data: IntentionResponse | undefined,
  ): CheckoutResult {
    const paymob = this.settings();
    const clientSecret = text(data?.client_secret);
    const intentionId = text(data?.id);
    const echoed = text(data?.special_reference);
    // An intention that came back for a different reference is not ours; using
    // its checkout URL would collect money against another purchase.
    if (!clientSecret || !intentionId || (echoed && echoed !== input.reference))
      return { outcome: 'rejected', code: 'invalid_intention_response' };

    const checkoutUrl = new URL(
      `/unifiedcheckout/?publicKey=${encodeURIComponent(paymob.publicKey)}&clientSecret=${encodeURIComponent(clientSecret)}`,
      paymob.baseUrl,
    ).toString();
    this.logger.log(
      buildBackendLog(PaymobPaymentsAdapter.name, {
        action: 'paymob-create-intention',
        outcome: 'success',
        // Never the client secret or the checkout URL that embeds it.
        reference: input.reference,
        providerIntentionId: intentionId,
      }),
    );
    return {
      outcome: 'created',
      payment: {
        reference: input.reference,
        providerIntentionId: intentionId,
        providerOrderId: text(data?.intention_order_id),
      },
      checkoutUrl,
      expiresAt: new Date(
        Date.now() + paymob.checkoutExpirationSeconds * 1000,
      ).toISOString(),
    };
  }

  private readInquiry(
    input: PaymentReference,
    data: { transaction?: unknown } | undefined,
  ): PaymentInquiryResult {
    const transaction = (data?.transaction ?? data) as
      | Record<string, unknown>
      | undefined;
    if (!transaction || typeof transaction !== 'object')
      return { outcome: 'not_found', code: 'not_found' };
    const amountMinor = Number(transaction.amount_cents);
    const currency = text(transaction.currency);
    if (!Number.isSafeInteger(amountMinor) || !currency)
      return { outcome: 'unknown', code: 'unreadable_inquiry_response' };

    // Normalized through the same mapper the callback uses, so the fingerprint
    // is identical and whichever arrival lands second is a proven replay.
    let event: NormalizedProviderEvent;
    try {
      event = mapPaymobCallback(
        { type: 'TRANSACTION', obj: transaction },
        {
          source: 'inquiry',
          mode: this.settings().mode,
          reference: input.reference,
        },
      );
    } catch {
      return { outcome: 'unknown', code: 'unreadable_inquiry_response' };
    }

    const signal = paymobSignal(transaction as never);
    const status: PurchaseStatus =
      signal === 'success'
        ? 'successful'
        : signal === 'refund'
          ? 'refunded'
          : signal === 'void'
            ? 'canceled'
            : signal === 'pending'
              ? 'pending'
              : 'failed';
    return {
      outcome: 'found',
      payment: {
        reference: input.reference,
        providerIntentionId: input.providerIntentionId,
        providerOrderId:
          text(
            (transaction.order as Record<string, unknown> | undefined)?.id,
          ) ?? input.providerOrderId,
        providerTransactionId: text(transaction.id),
      },
      mode: this.settings().mode,
      status,
      disputeStatus: 'none',
      totalMinor: amountMinor,
      currency: currency.toUpperCase(),
      refundedMinor: Number(transaction.refunded_amount_cents) || 0,
      event,
    };
  }

  /**
   * Splits a failure into "Paymob refused" and "we do not know".
   *
   * The distinction decides whether the local purchase fails immediately or
   * stays pending for inquiry, so a 4xx we can read is definitive and anything
   * else -- timeout, 5xx, socket error -- is not.
   */
  private classify(
    action: string,
    reference: string,
    error: unknown,
  ): CheckoutResult {
    this.logFailure(action, reference, error);
    const status = isAxiosError(error) ? (error.response?.status ?? 0) : 0;
    if (status >= 400 && status < 500 && status !== 408 && status !== 429)
      return { outcome: 'rejected', code: 'provider_rejected' };
    return { outcome: 'unknown', code: 'provider_unavailable' };
  }

  private logFailure(action: string, reference: string, error: unknown): void {
    const paymob = this.settings();
    this.logger.error(
      buildBackendLog(PaymobPaymentsAdapter.name, {
        action: `paymob-${action}`,
        outcome: 'failure',
        provider: PAYMOB_PROVIDER,
        reference,
        httpStatus: isAxiosError(error) ? error.response?.status : undefined,
        // A 4xx is Paymob explaining a refusal (a wrong integration id, a bad
        // field), so its messages are logged -- scrubbed and bounded, never the
        // raw body, which can carry the client secret.
        providerError: providerErrorSummary(error, [
          paymob.secretKey,
          paymob.publicKey,
          paymob.hmacSecret,
        ]),
        // `normalizeError` reports the message and name only.
        ...normalizeError(error),
      }),
    );
  }
}

/** Longest provider error summary one log line carries. */
const PROVIDER_ERROR_MAX_LENGTH = 300;

/** Paymob key and client-secret shapes, e.g. `egy_sk_test_…`, `egy_csk_live_…`. */
const PROVIDER_KEY_PATTERN =
  /\b(?:[a-z]{2,4}_)?(?:sk|pk|csk|cs)_(?:test|live)_[\w\-.=]+/gi;

/** Any long unbroken token: a legacy API key, an HMAC, a JWT. */
const LONG_TOKEN_PATTERN = /[\w\-+/=.]{32,}/g;

/** Fields whose value is data rather than an explanation. */
const SENSITIVE_FIELD =
  /secret|key|token|hmac|signature|password|phone|email|msisdn|card/i;

const MESSAGE_FIELDS = new Set(['detail', 'message', 'error']);

/**
 * Paymob's own words for a 4xx, safe to write down.
 *
 * Reads only top-level string messages -- `{ detail }` or DRF-style
 * `{ field: ['msg'] }` -- skips any field that names a credential or personal
 * data, then scrubs configured secrets and anything shaped like a key. A 5xx or
 * a timeout says nothing useful about the request, so it yields nothing.
 */
function providerErrorSummary(
  error: unknown,
  secrets: readonly string[],
): string | undefined {
  if (!isAxiosError(error)) return undefined;
  const status = error.response?.status ?? 0;
  if (status < 400 || status >= 500) return undefined;
  const data: unknown = error.response?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data))
    return undefined;

  const parts: string[] = [];
  for (const [field, value] of Object.entries(
    data as Record<string, unknown>,
  )) {
    if (SENSITIVE_FIELD.test(field)) continue;
    const messages = (Array.isArray(value) ? value : [value]).filter(
      (entry): entry is string =>
        typeof entry === 'string' && entry.trim() !== '',
    );
    if (!messages.length) continue;
    const message = messages.join(', ');
    parts.push(MESSAGE_FIELDS.has(field) ? message : `${field}: ${message}`);
  }
  if (!parts.length) return undefined;

  let summary = parts.join('; ');
  for (const secret of secrets)
    if (secret) summary = summary.split(secret).join('[redacted]');
  summary = summary
    .replace(PROVIDER_KEY_PATTERN, '[redacted]')
    .replace(LONG_TOKEN_PATTERN, '[redacted]');
  return summary.length > PROVIDER_ERROR_MAX_LENGTH
    ? `${summary.slice(0, PROVIDER_ERROR_MAX_LENGTH)}…`
    : summary;
}

function retryable(error: unknown): boolean {
  if (!isAxiosError(error)) return false;
  const status = error.response?.status;
  return status === undefined || status >= 500 || status === 429;
}
