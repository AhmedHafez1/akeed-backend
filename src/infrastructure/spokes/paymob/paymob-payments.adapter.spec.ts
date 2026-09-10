import { AxiosError, type AxiosResponse } from 'axios';
import { Logger } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import type { HttpService } from '@nestjs/axios';
import { standaloneCreditBillingConfigService } from '../../../../test/contracts/standalone-credit-billing-config';
import { PaymobPaymentsAdapter } from './paymob-payments.adapter';

const SECRET_KEY = 'sk_test_super_secret';
const PUBLIC_KEY = 'pk_test_public';
const HMAC_SECRET = 'hmac_test_secret';
const CLIENT_SECRET = 'cs_test_client_secret_value';

const config = standaloneCreditBillingConfigService({
  STANDALONE_CREDIT_BILLING_ENABLED: 'true',
  PAYMOB_MODE: 'test',
  PAYMOB_BASE_URL: 'http://localhost:9000',
  PAYMOB_CALLBACK_URL: 'http://localhost:9000/api/webhooks/payments/paymob',
  PAYMOB_RETURN_URL: 'http://localhost:9000/billing/return',
  PAYMOB_SECRET_KEY: SECRET_KEY,
  PAYMOB_PUBLIC_KEY: PUBLIC_KEY,
  PAYMOB_HMAC_SECRET: HMAC_SECRET,
  PAYMOB_CARD_INTEGRATION_ID: 'card1',
  PAYMOB_WALLET_INTEGRATION_ID: 'wallet1',
  PAYMOB_CHECKOUT_EXPIRATION_SECONDS: '900',
});

const checkout = {
  reference: 'akd_1111111111111111111111111111aaaa',
  quantity: 100,
  unitPriceMinor: 200,
  totalMinor: 20000,
  currency: 'EGP',
  expiresAt: '2026-09-09T10:30:00.000Z',
};

function response<T>(data: T, status = 200): AxiosResponse<T> {
  return { data, status, statusText: 'OK', headers: {}, config: {} as never };
}

function axiosFailure(status?: number): AxiosError {
  const error = new AxiosError('provider failure');
  if (status !== undefined)
    error.response = response({ detail: 'nope' }, status) as never;
  else error.code = 'ECONNABORTED';
  return error;
}

function build(post: jest.Mock) {
  const http = { post } as unknown as HttpService;
  return new PaymobPaymentsAdapter(http, config);
}

describe('PaymobPaymentsAdapter.createCheckout', () => {
  it('sends the trusted amount, both integrations and the internal reference', async () => {
    const post = jest.fn(() =>
      of(
        response({
          id: 'int_1',
          client_secret: CLIENT_SECRET,
          intention_order_id: 'ord_1',
          special_reference: checkout.reference,
        }),
      ),
    );
    await build(post).createCheckout(checkout);

    const [url, body, options] = post.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
      { headers: Record<string, string>; timeout: number },
    ];
    // Never a hard-coded provider host: everything goes to the configured base.
    expect(new URL(url).origin).toBe('http://localhost:9000');
    expect(body).toMatchObject({
      amount: 20000,
      currency: 'EGP',
      payment_methods: ['card1', 'wallet1'],
      special_reference: checkout.reference,
      expiration: 900,
      notification_url: 'http://localhost:9000/api/webhooks/payments/paymob',
      redirection_url: `http://localhost:9000/billing/return?purchaseRef=${checkout.reference}`,
      items: [{ amount: 200, quantity: 100 }],
    });
    expect(options.headers.Authorization).toBe(`Token ${SECRET_KEY}`);
    expect(options.timeout).toBeGreaterThan(0);
  });

  it('sends no merchant personal data', async () => {
    const post = jest.fn(() =>
      of(response({ id: 'int_1', client_secret: CLIENT_SECRET })),
    );
    await build(post).createCheckout(checkout);
    const [, body] = post.mock.calls[0] as unknown as [
      string,
      { billing_data: unknown },
    ];
    // Paymob requires a billing block; a credit top-up has no customer, so it
    // gets placeholders rather than anybody's real details.
    expect(JSON.stringify(body.billing_data)).not.toMatch(/@(?!akeed\.app)/);
    expect(body.billing_data).toMatchObject({ country: 'EG', city: 'NA' });
  });

  it('builds the checkout URL from the public key and the returned secret', async () => {
    const post = jest.fn(() =>
      of(
        response({
          id: 'int_1',
          client_secret: CLIENT_SECRET,
          intention_order_id: 'ord_1',
        }),
      ),
    );
    const result = await build(post).createCheckout(checkout);
    expect(result).toMatchObject({
      outcome: 'created',
      payment: {
        reference: checkout.reference,
        providerIntentionId: 'int_1',
        providerOrderId: 'ord_1',
      },
    });
    const url = new URL((result as { checkoutUrl: string }).checkoutUrl);
    expect(url.pathname).toBe('/unifiedcheckout/');
    expect(url.searchParams.get('publicKey')).toBe(PUBLIC_KEY);
    expect(url.searchParams.get('clientSecret')).toBe(CLIENT_SECRET);
  });

  it.each([
    ['no client secret', { id: 'int_1' }],
    ['no intention id', { client_secret: CLIENT_SECRET }],
    [
      'a reference for another purchase',
      {
        id: 'int_1',
        client_secret: CLIENT_SECRET,
        special_reference: 'akd_someone_else',
      },
    ],
  ])('rejects a response with %s', async (_label, data) => {
    const post = jest.fn(() => of(response(data)));
    await expect(build(post).createCheckout(checkout)).resolves.toMatchObject({
      outcome: 'rejected',
      code: 'invalid_intention_response',
    });
  });

  it.each([400, 401, 403, 422])(
    'treats HTTP %d as a definitive rejection',
    async (status) => {
      const post = jest.fn(() => throwError(() => axiosFailure(status)));
      await expect(build(post).createCheckout(checkout)).resolves.toMatchObject(
        { outcome: 'rejected', code: 'provider_rejected' },
      );
    },
  );

  it.each([500, 502, 503, 429, 408])(
    'treats HTTP %d as an unknown outcome, not a failure',
    async (status) => {
      const post = jest.fn(() => throwError(() => axiosFailure(status)));
      await expect(build(post).createCheckout(checkout)).resolves.toMatchObject(
        { outcome: 'unknown', code: 'provider_unavailable' },
      );
    },
  );

  it('treats a timeout as unknown and never asks twice', async () => {
    // A repeat could create a second intention for one purchase, which is the
    // duplicate-charge failure this whole flow is built to avoid.
    const post = jest.fn(() => throwError(() => axiosFailure()));
    await expect(build(post).createCheckout(checkout)).resolves.toMatchObject({
      outcome: 'unknown',
    });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('never writes a secret, a client secret or a checkout URL to the log', async () => {
    const logged: unknown[] = [];
    jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation((message) => logged.push(message));
    jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((message) => logged.push(message));
    const ok = jest.fn(() =>
      of(response({ id: 'int_1', client_secret: CLIENT_SECRET })),
    );
    await build(ok).createCheckout(checkout);
    const failing = jest.fn(() => throwError(() => axiosFailure(500)));
    await build(failing).createCheckout(checkout);

    const text = JSON.stringify(logged);
    for (const secret of [
      SECRET_KEY,
      HMAC_SECRET,
      CLIENT_SECRET,
      'unifiedcheckout',
    ])
      expect(text).not.toContain(secret);
    jest.restoreAllMocks();
  });
});

/** Fields every real inquiry response carries and the mapper requires. */
const inquiryBase = {
  integration_id: 'card1',
  created_at: '2026-09-09T10:15:30.123456',
  currency: 'EGP',
  amount_cents: 20000,
};

describe('PaymobPaymentsAdapter.inquire', () => {
  const reference = { reference: checkout.reference };

  it('reports a settled transaction as successful', async () => {
    const post = jest.fn(() =>
      of(
        response({
          transaction: {
            ...inquiryBase,
            id: 720001,
            order: { id: 510001 },
            success: true,
            pending: false,
          },
        }),
      ),
    );
    await expect(build(post).inquire(reference)).resolves.toMatchObject({
      outcome: 'found',
      status: 'successful',
      totalMinor: 20000,
      currency: 'EGP',
      payment: { providerTransactionId: '720001', providerOrderId: '510001' },
    });
  });

  it.each([
    [{ success: false, pending: true }, 'pending'],
    [{ success: false, pending: false }, 'failed'],
    [{ success: true, is_voided: true }, 'canceled'],
    [{ success: true, is_refunded: true }, 'refunded'],
  ])('maps %p to %s', async (flags, status) => {
    const post = jest.fn(() =>
      of(
        response({
          transaction: { ...inquiryBase, id: 1, ...flags },
        }),
      ),
    );
    await expect(build(post).inquire(reference)).resolves.toMatchObject({
      status,
    });
  });

  it('reports a 404 as a definitive not-found', async () => {
    const post = jest.fn(() => throwError(() => axiosFailure(404)));
    await expect(build(post).inquire(reference)).resolves.toMatchObject({
      outcome: 'not_found',
    });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('retries a server error, because asking again cannot create anything', async () => {
    const post = jest
      .fn()
      .mockReturnValueOnce(throwError(() => axiosFailure(500)))
      .mockReturnValueOnce(
        of(
          response({
            transaction: { ...inquiryBase, id: 1, success: true },
          }),
        ),
      );
    await expect(build(post).inquire(reference)).resolves.toMatchObject({
      outcome: 'found',
      status: 'successful',
    });
    expect(post).toHaveBeenCalledTimes(2);
  }, 20_000);

  it('gives up as unknown rather than guessing', async () => {
    const post = jest.fn(() => throwError(() => axiosFailure(500)));
    await expect(build(post).inquire(reference)).resolves.toMatchObject({
      outcome: 'unknown',
      code: 'provider_unavailable',
    });
  }, 30_000);

  it('refuses to read a response with no usable amount', async () => {
    const post = jest.fn(() =>
      of(response({ transaction: { id: 1, currency: 'EGP' } })),
    );
    await expect(build(post).inquire(reference)).resolves.toMatchObject({
      outcome: 'unknown',
      code: 'unreadable_inquiry_response',
    });
  });
});
