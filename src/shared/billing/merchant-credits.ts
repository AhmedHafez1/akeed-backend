/**
 * The one place stored credits become the credits a merchant sees.
 *
 * A stored credit pays for one Akeed message and costs the configured price
 * (EGP 1 by default). A displayed credit is half of one, so an own-number
 * message, which costs half, is a whole displayed credit. Merchants see these
 * as money: displayed credits times the displayed unit price. Nothing stored
 * changes: ledgers, reservations, purchases and every balance gate stay in
 * stored credits, and only values leaving for a merchant pass through here.
 */
export const DISPLAYED_CREDITS_PER_STORED = 2;

/** Displayed credits one message from the Akeed number uses. */
export const CREDITS_PER_AKEED_MESSAGE = DISPLAYED_CREDITS_PER_STORED;

/** Displayed credits one message from the merchant's own number uses. */
export const CREDITS_PER_OWN_NUMBER_MESSAGE = 1;

/**
 * A stored balance plus the account's spare, as the merchant sees it. The
 * spare is an own-number message already paid for: one displayed credit.
 */
export function toDisplayedBalance(stored: number, spareCredit = 0): number {
  return toDisplayedCredits(stored) + (spareCredit === 1 ? 1 : 0);
}

export class OddDisplayedCreditsError extends Error {
  constructor() {
    super('A displayed credit quantity must be even.');
  }
}

export function toDisplayedCredits(stored: number): number {
  return stored * DISPLAYED_CREDITS_PER_STORED;
}

/** Refuses an odd quantity: half a stored credit cannot be bought. */
export function toStoredCredits(displayed: number): number {
  if (displayed % DISPLAYED_CREDITS_PER_STORED !== 0)
    throw new OddDisplayedCreditsError();
  return displayed / DISPLAYED_CREDITS_PER_STORED;
}

/** The price of one displayed credit. Configuration guarantees it is whole. */
export function displayedUnitPriceMinor(storedUnitPriceMinor: number): number {
  return storedUnitPriceMinor / DISPLAYED_CREDITS_PER_STORED;
}

/** What one message costs the merchant, from the stored credit price. */
export function messagePricesMinor(storedUnitPriceMinor: number): {
  akeedMessagePriceMinor: number;
  ownNumberMessagePriceMinor: number;
} {
  return {
    akeedMessagePriceMinor:
      displayedUnitPriceMinor(storedUnitPriceMinor) * CREDITS_PER_AKEED_MESSAGE,
    ownNumberMessagePriceMinor:
      displayedUnitPriceMinor(storedUnitPriceMinor) *
      CREDITS_PER_OWN_NUMBER_MESSAGE,
  };
}

/**
 * Usage numbers for a merchant. These fields hold plan confirmations on a
 * subscription and credits on a prepaid source, and only a prepaid entitlement
 * carries `credits`, so that is what decides whether they convert.
 */
export function displayedUsage(entitlement: {
  consumedCount: number;
  includedLimit: number;
  credits?: { spareCredit?: number } | null;
}): { used: number; limit: number; remaining: number } {
  const prepaid = 'credits' in entitlement;
  const factor = prepaid ? DISPLAYED_CREDITS_PER_STORED : 1;
  const used = entitlement.consumedCount * factor;
  const limit =
    entitlement.includedLimit * factor +
    (prepaid && entitlement.credits?.spareCredit === 1 ? 1 : 0);
  return { used, limit, remaining: Math.max(limit - used, 0) };
}

/** Blockers that carry a credit shortfall. Plan slots are left alone. */
export function displayedCreditBlocker<
  T extends { shortfall?: number; suggestedPurchaseCredits?: number },
>(blocker: T): T {
  return {
    ...blocker,
    ...(blocker.shortfall === undefined
      ? {}
      : { shortfall: toDisplayedCredits(blocker.shortfall) }),
    ...(blocker.suggestedPurchaseCredits === undefined
      ? {}
      : {
          suggestedPurchaseCredits: toDisplayedCredits(
            blocker.suggestedPurchaseCredits,
          ),
        }),
  };
}

/**
 * A start quote for a merchant. The stored form is what the quote token and the
 * stale check compare, so this runs only as the quote leaves. A plan-billed
 * import counts messages in these fields, and they stay as they are.
 */
export function displayedStartQuote<
  T extends {
    accountingMode: string;
    creditsAvailable: number | null;
    estimatedCreditsMin: number;
    estimatedCreditsMax: number;
    blockers: { shortfall?: number; suggestedPurchaseCredits?: number }[];
    /** Messages that would go from the merchant's own number. */
    ownNumber?: { spareCredit: number };
  },
>(
  quote: T,
): Omit<T, 'ownNumber'> & {
  estimatedMessagesMin: number;
  estimatedMessagesMax: number;
} {
  const { ownNumber, ...stored } = quote;
  const messages = {
    estimatedMessagesMin: quote.estimatedCreditsMin,
    estimatedMessagesMax: quote.estimatedCreditsMax,
  };
  if (quote.accountingMode !== 'prepaid_credit')
    return { ...stored, ...messages };
  const perMessage = ownNumber
    ? CREDITS_PER_OWN_NUMBER_MESSAGE
    : CREDITS_PER_AKEED_MESSAGE;
  return {
    ...stored,
    ...messages,
    creditsAvailable:
      quote.creditsAvailable === null
        ? null
        : toDisplayedBalance(quote.creditsAvailable, ownNumber?.spareCredit),
    estimatedCreditsMin: quote.estimatedCreditsMin * perMessage,
    estimatedCreditsMax: quote.estimatedCreditsMax * perMessage,
    blockers: quote.blockers.map(displayedCreditBlocker),
  };
}

export interface DisplayedPurchaseTerms {
  quantity: number;
  unitPriceMinor: number;
}

/** A purchase as the merchant bought it. The total is the same either way. */
export function displayedPurchaseTerms(
  stored: DisplayedPurchaseTerms,
): DisplayedPurchaseTerms {
  return {
    quantity: toDisplayedCredits(stored.quantity),
    unitPriceMinor: displayedUnitPriceMinor(stored.unitPriceMinor),
  };
}
