import { ConfigService } from '@nestjs/config';
import type { CreditAccountingRepository } from '../../infrastructure/database/repositories/credit-accounting.repository';
import {
  parseStandaloneCreditBillingConfig,
  STANDALONE_CREDIT_BILLING_CONFIG,
} from '../../shared/config/standalone-credit-billing.config';
import {
  CREDIT_APPROVAL_REQUIRED_REASON,
  CreditApprovalService,
} from './credit-approval.service';

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
  status?: 'pending_approval' | 'active' | 'suspended',
) {
  const getSummary = jest.fn().mockResolvedValue(
    status
      ? {
          orgId: 'org-1',
          status,
          postedBalance: 30,
          availableCredits: 30,
          debtCredits: 0,
          heldCredits: 0,
        }
      : undefined,
  );
  const credits = { getSummary } as unknown as CreditAccountingRepository;
  const service = new CreditApprovalService(
    credits,
    new ConfigService({
      [STANDALONE_CREDIT_BILLING_CONFIG]:
        parseStandaloneCreditBillingConfig(environment),
    }),
  );
  return { service, getSummary };
}

describe('CreditApprovalService', () => {
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
  it('leaves the advisory approval gate inert while disabled', async () => {
    const { service, getSummary } = build({}, 'pending_approval');

    await expect(
      service.readStatus({ orgId: 'org-1', platformType: 'standalone' }),
    ).resolves.toBeNull();
    await expect(
      service.resolveDenial({ orgId: 'org-1', platformType: 'standalone' }),
    ).resolves.toBeNull();
    expect(getSummary).not.toHaveBeenCalled();
  });

  /**
   * The credit account row is what subscribes an organization to prepaid
   * billing, so a Shopify organization without one keeps its plan entitlement
   * and is never blocked here.
   */
  it('requires approval when the Standalone account is missing', async () => {
    const { service } = build(ENABLED);

    await expect(
      service.isApproved({ orgId: 'org-1', platformType: 'standalone' }),
    ).resolves.toBe(false);
  });

  it.each(['pending_approval', 'suspended'] as const)(
    'denies a %s account',
    async (status) => {
      const { service } = build(ENABLED, status);

      await expect(
        service.resolveDenial({ orgId: 'org-1', platformType: 'standalone' }),
      ).resolves.toBe(
        status === 'suspended'
          ? 'CREDIT_ACCOUNT_SUSPENDED'
          : CREDIT_APPROVAL_REQUIRED_REASON,
      );
    },
  );

  it('allows an active account', async () => {
    const { service } = build(ENABLED, 'active');

    await expect(
      service.readStatus({ orgId: 'org-1', platformType: 'standalone' }),
    ).resolves.toBe('active');
    await expect(
      service.resolveDenial({ orgId: 'org-1', platformType: 'standalone' }),
    ).resolves.toBeNull();
  });
});
