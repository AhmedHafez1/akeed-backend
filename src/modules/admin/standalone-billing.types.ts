import type { CreditAccountStatus } from '../../shared/ports/credit-accounting.port';
import type { AccountBillingSummary } from './standalone-billing-operations.types';

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
  version: number;
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
