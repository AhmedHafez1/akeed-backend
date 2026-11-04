import { creditDenial } from './credit-eligibility';
import {
  CREDITS_PER_OWN_NUMBER_MESSAGE,
  displayedStartQuote,
  displayedUsage,
  toDisplayedBalance,
} from './merchant-credits';
import { creditAlertLevels, recoveredCreditLevels } from './usage-alert.policy';
import type { CreditSummary } from '../ports/credit-accounting.port';

const summary = (overrides: Partial<CreditSummary> = {}): CreditSummary => ({
  orgId: 'org',
  status: 'active',
  postedBalance: 0,
  heldCredits: 0,
  availableCredits: 0,
  debtCredits: 0,
  version: 1,
  ...overrides,
});

describe('own-number gates and display', () => {
  it('lets a spare pay for an own-number send but not an Akeed one', () => {
    const spareOnly = summary({ spareCredit: 1 });
    expect(creditDenial(spareOnly)).toBe('INSUFFICIENT_CREDITS');
    expect(creditDenial(spareOnly, 2)).toBe('INSUFFICIENT_CREDITS');
    expect(creditDenial(spareOnly, 1)).toBeNull();
    expect(creditDenial(summary(), 1)).toBe('INSUFFICIENT_CREDITS');
  });

  it('never blocks a fallback on balance, but still on debt and suspension', () => {
    expect(creditDenial(summary(), 0)).toBeNull();
    expect(
      creditDenial(summary({ postedBalance: -1, debtCredits: 1 }), 0),
    ).toBe('CREDIT_DEBT_OUTSTANDING');
    expect(creditDenial(summary({ status: 'suspended' }), 0)).toBe(
      'CREDIT_ACCOUNT_SUSPENDED',
    );
  });

  it('keeps the Akeed-number rule exactly as before when no cost is given', () => {
    for (const available of [0, 1, 2])
      for (const spareCredit of [0, 1])
        expect(
          creditDenial(
            summary({
              postedBalance: available,
              availableCredits: available,
              spareCredit,
            }),
          ),
        ).toBe(available < 1 ? 'INSUFFICIENT_CREDITS' : null);
  });

  it('shows the spare as one displayed credit', () => {
    expect(toDisplayedBalance(4)).toBe(8);
    expect(toDisplayedBalance(4, 1)).toBe(9);
    expect(toDisplayedBalance(4, 0)).toBe(8);
    expect(
      displayedUsage({
        consumedCount: 1,
        includedLimit: 4,
        credits: { spareCredit: 1 },
      }),
    ).toEqual({ used: 2, limit: 9, remaining: 7 });
  });

  it('prices an own-number import at one credit a message', () => {
    expect(CREDITS_PER_OWN_NUMBER_MESSAGE).toBe(1);
    const quote = displayedStartQuote({
      accountingMode: 'prepaid_credit',
      creditsAvailable: 10,
      estimatedCreditsMin: 15,
      estimatedCreditsMax: 30,
      blockers: [],
      ownNumber: { spareCredit: 1 },
    });
    expect(quote).toEqual({
      accountingMode: 'prepaid_credit',
      creditsAvailable: 21,
      estimatedCreditsMin: 15,
      estimatedCreditsMax: 30,
      estimatedMessagesMin: 15,
      estimatedMessagesMax: 30,
      blockers: [],
    });
    expect(quote).not.toHaveProperty('ownNumber');
  });

  it('is not depleted while a spare pays for the next own-number send', () => {
    expect(creditAlertLevels(0, 5)).toEqual(['low', 'depleted']);
    expect(creditAlertLevels(0, 5, true)).toEqual(['low']);
    expect(recoveredCreditLevels(0, 5, true)).toEqual(['depleted']);
  });
});
