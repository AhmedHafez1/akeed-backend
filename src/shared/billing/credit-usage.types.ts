export interface CreditUsageDay {
  date: string;
  credits: number;
  akeedCredits: number;
  ownNumberCredits: number;
}

/** Displayed credits, attributed to the accepted send day, net of refunds. */
export interface CreditUsage {
  asOf: string;
  timeZone: string;
  monthStart: string;
  usedThisMonth: number;
  bySender: { akeed: number; ownNumber: number };
  daily: CreditUsageDay[];
}
