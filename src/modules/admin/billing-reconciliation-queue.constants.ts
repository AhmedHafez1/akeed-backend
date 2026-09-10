export const BILLING_RECONCILIATION_QUEUE = 'billing-reconciliation';
export const BILLING_RECONCILIATION_JOB = 'reconcile-standalone-billing';
export const BILLING_RECONCILIATION_SCHEDULER = 'standalone-billing-nightly';

export interface BillingReconciliationJob {
  runId?: string;
  trigger: 'nightly' | 'settlement' | 'manual';
  settlementId?: string;
}
