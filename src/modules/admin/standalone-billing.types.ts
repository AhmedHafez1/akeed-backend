import type { CreditAccountStatus } from '../../shared/ports/credit-accounting.port';
import type { AccountBillingSummary } from './standalone-billing-operations.types';
import type { CheckoutOutcome } from './checkout-attempts.policy';

export interface AccountSource {
  id: string;
  identity: string;
  platformType: string;
  isActive: boolean | null;
  billingPlanId: string | null;
  billingStatus: string | null;
  billingActivatedAt: string | null;
}

export interface AccountSnapshot {
  status: CreditAccountStatus;
  postedBalance: number;
  heldCredits: number;
  availableCredits: number;
  /** Available plus any unused own-number half: the balance staff read. */
  balance: number;
  version: number;
}

/**
 * One merchant who started a live Paymob checkout, with what staff need to
 * follow up: how it ended and how to reach the owner.
 */
export interface CheckoutAttemptRow {
  orgId: string;
  organizationName: string | null;
  owner: {
    name: string | null;
    email: string | null;
    whatsappPhone: string | null;
  };
  source: { platformType: string; identity: string } | null;
  attempts: number;
  firstAttemptAt: string;
  lastAttemptAt: string;
  paidEver: boolean;
  latest: {
    reference: string;
    status: string;
    outcome: CheckoutOutcome;
    declineCode: string | null;
    reconciliationCode: string | null;
    totalMinor: number;
    currency: string;
  };
}

/** One organization as the staff account list shows it. */
export interface AccountRow {
  orgId: string;
  organizationName: string | null;
  source: AccountSource | null;
  account: AccountSnapshot | null;
  freeGrantPresent: boolean;
  billing: AccountBillingSummary | null;
}
