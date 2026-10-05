import { DrizzleQueryError } from 'drizzle-orm';
import {
  buildBackendLog,
  normalizeError,
  withoutQueryParameters,
} from './backend-log.util';

describe('buildBackendLog', () => {
  it('recursively redacts billing credentials, evidence, and customer data', () => {
    const parsed = JSON.parse(
      buildBackendLog('Billing', {
        action: 'standalone-billing-alert',
        outcome: 'failure',
        hmac: 'signature',
        api_key: 'key',
        checkoutUrl: 'https://checkout.example/secret',
        evidence: 'private report URL',
        rawPayload: { pan: '4111111111111111', token: 'wallet-token' },
        phone: '+201000000000',
        email: 'person@example.com',
        searchableReference: 'provider-order-1',
      }),
    ) as Record<string, unknown>;

    expect(parsed).toMatchObject({
      hmac: '[REDACTED]',
      api_key: '[REDACTED]',
      checkoutUrl: '[REDACTED]',
      evidence: '[REDACTED]',
      rawPayload: '[REDACTED]',
      phone: '[REDACTED]',
      email: '[REDACTED]',
      searchableReference: 'provider-order-1',
    });
  });

  it('redacts nested card, wallet and Paymob credential fields at any depth', () => {
    const line = buildBackendLog('Billing', {
      action: 'standalone-billing-alert',
      outcome: 'failure',
      alertCode: 'trusted_data_mismatch',
      orgId: 'org-1',
      reference: 'akd_reference',
      provider: {
        secretKey: 'sk_live_value',
        hmacSecret: 'hmac_value',
        publicKey: 'pk_value',
        clientSecret: 'cs_value',
        source: {
          pan: '512345xxxxxx2346',
          cardNumber: '5123450000002346',
          walletNumber: '01000000000',
          walletToken: 'wallet-token-value',
          msisdn: '201000000000',
        },
        customers: [
          { customerEmail: 'a@example.com', customerPhone: '+20100' },
        ],
      },
      settlement: { evidence: 'drive://finance/private', netMinor: 19430 },
    });
    for (const secret of [
      'sk_live_value',
      'hmac_value',
      'pk_value',
      'cs_value',
      '512345',
      '5123450000002346',
      '01000000000',
      'wallet-token-value',
      '201000000000',
      'a@example.com',
      '+20100',
      'drive://finance/private',
    ])
      expect(line).not.toContain(secret);
    // Searchable references and bounded counters survive.
    expect(JSON.parse(line)).toMatchObject({
      alertCode: 'trusted_data_mismatch',
      orgId: 'org-1',
      reference: 'akd_reference',
      settlement: { netMinor: 19430 },
    });
  });
});

describe('normalizeError', () => {
  const PHONE = '+201000000000';
  const TOKEN_HASH = 'a'.repeat(64);
  const STATEMENT =
    'insert into "orders" ("customer_phone", "token_hash") values ($1, $2)';

  function failedQuery(cause?: Error): DrizzleQueryError {
    return new DrizzleQueryError(STATEMENT, [PHONE, TOKEN_HASH], cause);
  }

  it('keeps the statement and the driver code and message of a failed query, and none of its parameters', () => {
    const normalized = normalizeError(
      failedQuery(
        Object.assign(new Error('duplicate key value violates "orders_key"'), {
          code: '23505',
          detail: `Key (customer_phone)=(${PHONE}) already exists.`,
        }),
      ),
    );

    expect(normalized.errorMessage).toBe(
      `Failed query: ${STATEMENT}\n  cause: 23505 duplicate key value violates "orders_key"`,
    );
    const text = JSON.stringify(normalized);
    expect(text).not.toContain(PHONE);
    expect(text).not.toContain(TOKEN_HASH);
    expect(text).not.toContain('params:');
    // The frames are kept, so the failure can still be traced.
    expect(normalized.stack).toContain('backend-log.util.spec');
  });

  it('handles a failed query that carries no driver error', () => {
    const normalized = normalizeError(failedQuery());

    expect(normalized.errorMessage).toBe(`Failed query: ${STATEMENT}`);
    expect(JSON.stringify(normalized)).not.toContain(PHONE);
  });

  it('leaves every other error as it is', () => {
    const error = new TypeError('not a query');

    expect(normalizeError(error)).toEqual({
      errorName: 'TypeError',
      errorMessage: 'not a query',
      stack: error.stack,
    });
    expect(withoutQueryParameters(error)).toBe(error);
  });
});
