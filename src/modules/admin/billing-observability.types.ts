export type BillingFindingSeverity = 'attention' | 'critical';
export type BillingFindingStatus = 'open' | 'resolved';
export type BillingRunTrigger = 'nightly' | 'settlement' | 'manual';
export type BillingRunMode = 'local_only' | 'report_only' | 'active';

export interface BillingFindingInput {
  fingerprint: string;
  code: string;
  severity: BillingFindingSeverity;
  nextAction: string;
  orgId?: string;
  purchaseId?: string;
  settlementId?: string;
  retryCount?: number;
  nextAttemptAt?: string;
  safeContext?: Record<string, unknown>;
}

export interface SettlementInput {
  providerReportId: string;
  supersedesId?: string;
  periodStart: string;
  periodEnd: string;
  settledAt: string;
  currency: string;
  transactionCount: number;
  grossMinor: number;
  refundedMinor: number;
  chargebackMinor: number;
  feeMinor: number;
  vatMinor: number;
  netMinor: number;
  evidence: string;
  reason: string;
}

export const BILLING_OBSERVABILITY_ACTIONS = {
  run: 'standalone-billing.reconciliation.run',
  settlement: 'standalone-billing.settlement.record',
} as const;
