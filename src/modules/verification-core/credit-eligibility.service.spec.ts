import { ConfigService } from '@nestjs/config';
import type { CreditAccountingRepository } from '../../infrastructure/database/repositories/credit-accounting.repository';
import {
  parseStandaloneCreditBillingConfig,
  STANDALONE_CREDIT_BILLING_CONFIG,
} from '../../shared/config/standalone-credit-billing.config';
import { CreditEligibilityService } from './credit-eligibility.service';

const ENABLED = {
  STANDALONE_CREDIT_BILLING_ENABLED: 'true',
  PAYMOB_MODE: 'test',
  PAYMOB_BASE_URL: 'http://localhost:9000',
  PAYMOB_CALLBACK_URL: 'http://localhost:9000/api/webhooks/payments/paymob',
  PAYMOB_RETURN_URL: 'http://localhost:9000',
  PAYMOB_SECRET_KEY: 'sandbox-secret',
  PAYMOB_PUBLIC_KEY: 'sandbox-public',
  PAYMOB_HMAC_SECRET: 'sandbox-hmac',
  PAYMOB_CARD_INTEGRATION_ID: 'card1',
  PAYMOB_WALLET_INTEGRATION_ID: 'wallet1',
  PAYMOB_CHECKOUT_EXPIRATION_SECONDS: '900',
};

function build(
  environment: Record<string, string>,
  status?: 'active' | 'suspended',
  availableCredits = 30,
) {
  const getSummary = jest.fn().mockResolvedValue(
    status
      ? {
          orgId: 'org-1',
          status,
          postedBalance: availableCredits,
          availableCredits,
          debtCredits: 0,
          heldCredits: 0,
        }
      : undefined,
  );
  const credits = { getSummary } as unknown as CreditAccountingRepository;
  const service = new CreditEligibilityService(
    credits,
    new ConfigService({
      [STANDALONE_CREDIT_BILLING_CONFIG]:
        parseStandaloneCreditBillingConfig(environment),
    }),
  );
  return { service, getSummary };
}

const standalone = { orgId: 'org-1', platformType: 'standalone' };

describe('CreditEligibilityService', () => {
  it('never reads credit tables for Shopify', async () => {
    const { service, getSummary } = build(ENABLED);
    expect(
      await service.resolveDenial({ orgId: 'org-1', platformType: 'shopify' }),
    ).toBeNull();
    expect(
      await service.readStatus({ orgId: 'org-1', platformType: 'shopify' }),
    ).toBeNull();
    expect(getSummary).not.toHaveBeenCalled();
  });

  it('stays inert while credit billing is disabled', async () => {
    const { service, getSummary } = build({}, 'suspended');

    await expect(service.readStatus(standalone)).resolves.toBeNull();
    await expect(service.resolveDenial(standalone)).resolves.toBeNull();
    expect(getSummary).not.toHaveBeenCalled();
  });

  it('allows a freshly provisioned account holding its launch grant', async () => {
    const { service } = build(ENABLED, 'active');

    await expect(service.readStatus(standalone)).resolves.toBe('active');
    await expect(service.resolveDenial(standalone)).resolves.toBeNull();
  });

  it('denies a suspended account', async () => {
    const { service } = build(ENABLED, 'suspended');

    await expect(service.readStatus(standalone)).resolves.toBe('suspended');
    await expect(service.resolveDenial(standalone)).resolves.toBe(
      'CREDIT_ACCOUNT_SUSPENDED',
    );
  });

  it('denies an active account with no credits left', async () => {
    const { service } = build(ENABLED, 'active', 0);

    await expect(service.resolveDenial(standalone)).resolves.toBe(
      'INSUFFICIENT_CREDITS',
    );
  });

  /**
   * The accounting router answers for a missing account inside the send
   * transaction, so this advisory read never invents a waiting state.
   */
  it('reports no status and leaves denial to accounting when the account is missing', async () => {
    const { service } = build(ENABLED);

    await expect(service.readStatus(standalone)).resolves.toBeNull();
    await expect(service.resolveDenial(standalone)).resolves.toBeNull();
  });
});
