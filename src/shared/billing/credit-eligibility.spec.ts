import { creditDenial, usesPrepaidCredits } from './credit-eligibility';
import type { CreditSummary } from '../ports/credit-accounting.port';

describe('credit eligibility', () => {
  const active: CreditSummary = {
    orgId: 'org',
    status: 'active',
    postedBalance: 1,
    heldCredits: 0,
    availableCredits: 1,
    debtCredits: 0,
    version: 1,
  };
  it('requires a provisioned account and permits the last available credit', () => {
    expect(creditDenial(undefined)).toBe('CREDIT_ACCOUNT_NOT_PROVISIONED');
    expect(creditDenial(active)).toBeNull();
  });
  it('meters Standalone and connected store platforms, never Shopify', () => {
    for (const platformType of ['standalone', 'easyorders', 'woocommerce'])
      expect(usesPrepaidCredits({ platformType })).toBe(true);
    expect(usesPrepaidCredits({ platformType: 'shopify' })).toBe(false);
    expect(usesPrepaidCredits({ platformType: null })).toBe(false);
  });
  it('distinguishes suspension, debt and holds that exhaust availability', () => {
    expect(creditDenial({ ...active, status: 'suspended' })).toBe(
      'CREDIT_ACCOUNT_SUSPENDED',
    );
    expect(
      creditDenial({
        ...active,
        postedBalance: -1,
        availableCredits: 0,
        debtCredits: 1,
      }),
    ).toBe('CREDIT_DEBT_OUTSTANDING');
    expect(
      creditDenial({ ...active, heldCredits: 1, availableCredits: 0 }),
    ).toBe('INSUFFICIENT_CREDITS');
  });
});
