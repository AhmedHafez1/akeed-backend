import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { standaloneCreditBillingConfigService } from '../../../../test/contracts/standalone-credit-billing-config';
import {
  PaymobHmacGuard,
  type PaymobVerifiedRequest,
} from './paymob-hmac.guard';
import { signPaymobPayload } from './paymob-hmac';

const SECRET = 'sandbox-hmac';
const enabled = standaloneCreditBillingConfigService({
  STANDALONE_CREDIT_BILLING_ENABLED: 'true',
  PAYMOB_MODE: 'test',
  PAYMOB_BASE_URL: 'http://localhost:9000',
  PAYMOB_CALLBACK_URL: 'http://localhost:9000/api/webhooks/payments/paymob',
  PAYMOB_RETURN_URL: 'http://localhost:9000',
  PAYMOB_SECRET_KEY: 'sandbox-secret',
  PAYMOB_PUBLIC_KEY: 'sandbox-public',
  PAYMOB_HMAC_SECRET: SECRET,
  PAYMOB_CARD_INTEGRATION_ID: 'card1',
  PAYMOB_WALLET_INTEGRATION_ID: 'wallet1',
  PAYMOB_CHECKOUT_EXPIRATION_SECONDS: '900',
});
const disabled = standaloneCreditBillingConfigService();

const fixture = JSON.parse(
  readFileSync(
    join(__dirname, 'fixtures', 'transaction.card-success.json'),
    'utf8',
  ),
) as { body: { type: string; obj: Record<string, unknown> } };

function contextFor(
  request: Partial<PaymobVerifiedRequest> & { query?: Record<string, unknown> },
): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function callback(overrides: { body?: unknown; hmac?: unknown } = {}) {
  const payload = overrides.body ?? fixture.body;
  const request = {
    headers: { 'x-request-id': 'req-1' },
    rawBody: Buffer.from(JSON.stringify(payload), 'utf8'),
    query: {
      // `in` rather than `??`, so a case can assert an absent digest.
      hmac:
        'hmac' in overrides
          ? overrides.hmac
          : signPaymobPayload(fixture.body.obj, SECRET),
    },
  } as unknown as PaymobVerifiedRequest & { query: Record<string, unknown> };
  return request;
}

describe('PaymobHmacGuard', () => {
  it('verifies a genuine callback and hands the transaction to the controller', () => {
    const guard = new PaymobHmacGuard(enabled);
    const request = callback();
    expect(guard.canActivate(contextFor(request))).toBe(true);
    expect(request.paymobEvent).toMatchObject({
      type: 'TRANSACTION',
      obj: { id: 720001 },
    });
  });

  it('verifies against the bytes Paymob sent, not a reserialized body', () => {
    // Whitespace and key order change the body but not the signed values.
    const reordered = {
      obj: Object.fromEntries(Object.entries(fixture.body.obj).reverse()),
      type: 'TRANSACTION',
    };
    const guard = new PaymobHmacGuard(enabled);
    expect(guard.canActivate(contextFor(callback({ body: reordered })))).toBe(
      true,
    );
  });

  it.each([
    ['a missing digest', { hmac: undefined }],
    ['a malformed digest', { hmac: 'not-a-digest' }],
    [
      'a digest from another secret',
      { hmac: signPaymobPayload(fixture.body.obj, 'other') },
    ],
  ])('rejects %s', (_label, overrides) => {
    const guard = new PaymobHmacGuard(enabled);
    expect(() => guard.canActivate(contextFor(callback(overrides)))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a tampered amount even with a valid digest for the original', () => {
    const tampered = {
      type: 'TRANSACTION',
      obj: { ...fixture.body.obj, amount_cents: 1 },
    };
    const guard = new PaymobHmacGuard(enabled);
    expect(() =>
      guard.canActivate(contextFor(callback({ body: tampered }))),
    ).toThrow(UnauthorizedException);
  });

  it('rejects a payload missing a signed field rather than signing around it', () => {
    const truncated = { type: 'TRANSACTION', obj: { id: 720001 } };
    const guard = new PaymobHmacGuard(enabled);
    expect(() =>
      guard.canActivate(contextFor(callback({ body: truncated }))),
    ).toThrow(UnauthorizedException);
  });

  it.each([
    ['no raw body', { headers: {}, query: { hmac: 'x'.repeat(128) } }],
    [
      'an unparseable body',
      {
        headers: {},
        rawBody: Buffer.from('{not json', 'utf8'),
        query: { hmac: 'x'.repeat(128) },
      },
    ],
    [
      'no transaction object',
      {
        headers: {},
        rawBody: Buffer.from(JSON.stringify({ type: 'TRANSACTION' }), 'utf8'),
        query: { hmac: 'x'.repeat(128) },
      },
    ],
  ])('rejects a request with %s', (_label, request) => {
    const guard = new PaymobHmacGuard(enabled);
    expect(() => guard.canActivate(contextFor(request as never))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects everything while credit billing is switched off', () => {
    // There is no configured secret to verify against, so an authentic-looking
    // callback must not be treated as authentic.
    const guard = new PaymobHmacGuard(disabled);
    expect(() => guard.canActivate(contextFor(callback()))).toThrow(
      UnauthorizedException,
    );
  });

  it('leaves an unsupported event type for the controller to quarantine', () => {
    // Verifying first and answering 2xx is what stops Paymob retrying a TOKEN
    // event forever; the guard's job is authenticity, not event selection.
    const token = { type: 'TOKEN', obj: fixture.body.obj };
    const guard = new PaymobHmacGuard(enabled);
    const request = callback({ body: token });
    expect(guard.canActivate(contextFor(request))).toBe(true);
    expect(request.paymobEvent?.type).toBe('TOKEN');
  });
});
