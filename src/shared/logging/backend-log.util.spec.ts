import { buildBackendLog } from './backend-log.util';

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
