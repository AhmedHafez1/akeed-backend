/**
 * The one place stored credits become the credits a merchant sees.
 *
 * A stored credit is worth EGP 2 and pays for one Akeed message. Merchants see
 * 1 credit = EGP 1, so a message costs 2 of theirs. Nothing stored changes:
 * ledgers, reservations, purchases and every balance gate stay in stored
 * credits, and only values leaving for a merchant pass through here.
 */
export const DISPLAYED_CREDITS_PER_STORED = 2;

/** Displayed credits one message from the Akeed number uses. */
export const CREDITS_PER_AKEED_MESSAGE = DISPLAYED_CREDITS_PER_STORED;

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

/**
 * Usage numbers for a merchant. These fields hold plan confirmations on a
 * subscription and credits on a prepaid source, and only a prepaid entitlement
 * carries `credits`, so that is what decides whether they convert.
 */
export function displayedUsage(entitlement: {
  consumedCount: number;
  includedLimit: number;
  credits?: unknown;
}): { used: number; limit: number; remaining: number } {
  const factor = 'credits' in entitlement ? DISPLAYED_CREDITS_PER_STORED : 1;
  const used = entitlement.consumedCount * factor;
  const limit = entitlement.includedLimit * factor;
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
  },
>(
  quote: T,
): T & { estimatedMessagesMin: number; estimatedMessagesMax: number } {
  const messages = {
    estimatedMessagesMin: quote.estimatedCreditsMin,
    estimatedMessagesMax: quote.estimatedCreditsMax,
  };
  if (quote.accountingMode !== 'prepaid_credit')
    return { ...quote, ...messages };
  return {
    ...quote,
    ...messages,
    creditsAvailable:
      quote.creditsAvailable === null
        ? null
        : toDisplayedCredits(quote.creditsAvailable),
    estimatedCreditsMin: toDisplayedCredits(quote.estimatedCreditsMin),
    estimatedCreditsMax: toDisplayedCredits(quote.estimatedCreditsMax),
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
