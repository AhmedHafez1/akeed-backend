import {
  CREDITS_PER_AKEED_MESSAGE,
  displayedCreditBlocker,
  displayedPurchaseTerms,
  displayedStartQuote,
  displayedUnitPriceMinor,
  displayedUsage,
  messagePricesMinor,
  OddDisplayedCreditsError,
  storedBalance,
  storedCreditUsage,
  toDisplayedCredits,
  toStoredCredits,
} from './merchant-credits';

describe('merchant credits', () => {
  it('shows a stored credit as two', () => {
    expect(CREDITS_PER_AKEED_MESSAGE).toBe(2);
    expect(toDisplayedCredits(100)).toBe(200);
    expect(toDisplayedCredits(-1)).toBe(-2);
    expect(toDisplayedCredits(0)).toBe(0);
  });

  it('converts displayed quantities back, refusing odd ones', () => {
    expect(toStoredCredits(200)).toBe(100);
    expect(() => toStoredCredits(201)).toThrow(OddDisplayedCreditsError);
  });

  it('keeps every EGP total across the conversion', () => {
    for (const quantity of [100, 150, 2500, 5000]) {
      const stored = { quantity, unitPriceMinor: 200 };
      const displayed = displayedPurchaseTerms(stored);
      expect(displayed.quantity * displayed.unitPriceMinor).toBe(
        stored.quantity * stored.unitPriceMinor,
      );
    }
    expect(displayedUnitPriceMinor(200)).toBe(100);
  });

  it('converts usage for a prepaid entitlement only', () => {
    expect(
      displayedUsage({
        consumedCount: 3,
        includedLimit: 10,
        credits: undefined,
      }),
    ).toEqual({ used: 6, limit: 20, remaining: 14 });
    expect(displayedUsage({ consumedCount: 3, includedLimit: 10 })).toEqual({
      used: 3,
      limit: 10,
      remaining: 7,
    });
  });

  it('converts a credit blocker and leaves others alone', () => {
    expect(
      displayedCreditBlocker({
        code: 'INSUFFICIENT_CREDITS',
        shortfall: 30,
        suggestedPurchaseCredits: 100,
      }),
    ).toEqual({
      code: 'INSUFFICIENT_CREDITS',
      shortfall: 60,
      suggestedPurchaseCredits: 200,
    });
    expect(
      displayedCreditBlocker<{
        code: string;
        shortfall?: number;
        slotsRemaining: number;
      }>({ code: 'IMPORT_PLAN_LIMIT_REACHED', slotsRemaining: 4 }),
    ).toEqual({ code: 'IMPORT_PLAN_LIMIT_REACHED', slotsRemaining: 4 });
  });

  const quote = {
    orders: 40,
    creditsAvailable: 50,
    estimatedCreditsMin: 40,
    estimatedCreditsMax: 80,
    blockers: [],
  };

  it('converts a prepaid quote and keeps its message counts', () => {
    expect(
      displayedStartQuote({ ...quote, accountingMode: 'prepaid_credit' }),
    ).toMatchObject({
      orders: 40,
      creditsAvailable: 100,
      estimatedCreditsMin: 80,
      estimatedCreditsMax: 160,
      estimatedMessagesMin: 40,
      estimatedMessagesMax: 80,
    });
  });

  it('prices an Akeed message at a stored credit and an own-number one at half', () => {
    expect(messagePricesMinor(100)).toEqual({
      akeedMessagePriceMinor: 100,
      ownNumberMessagePriceMinor: 50,
    });
  });

  it('leaves a plan quote in messages', () => {
    expect(
      displayedStartQuote({
        ...quote,
        creditsAvailable: null,
        accountingMode: 'periodic_plan',
      }),
    ).toMatchObject({
      creditsAvailable: null,
      estimatedCreditsMin: 40,
      estimatedCreditsMax: 80,
      estimatedMessagesMin: 40,
      estimatedMessagesMax: 80,
    });
  });
});

describe('stored balance for staff', () => {
  it.each([
    [70, 0, 70],
    [70, 1, 70.5],
    [0, 1, 0.5],
    [-5, 0, 0],
  ])('reads %i stored with spare %i as %s', (stored, spare, balance) => {
    expect(storedBalance(stored, spare)).toBe(balance);
  });

  it('splits everything added into used and left', () => {
    expect(
      storedCreditUsage({ added: 170, available: 135, spareCredit: 1 }),
    ).toEqual({ added: 170, used: 34.5, left: 135.5, percent: 20 });
  });

  it('never shows more used than added, or a negative use', () => {
    expect(storedCreditUsage({ added: 10, available: 40 })).toEqual({
      added: 40,
      used: 0,
      left: 40,
      percent: 0,
    });
    expect(storedCreditUsage({ added: 100, available: 0 })).toMatchObject({
      used: 100,
      percent: 100,
    });
    expect(storedCreditUsage({ added: 0, available: 0 }).percent).toBe(0);
  });
});
