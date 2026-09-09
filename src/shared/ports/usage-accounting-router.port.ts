import type { CreditAccountingPort } from './credit-accounting.port';

export const USAGE_ACCOUNTING_ROUTER = Symbol('USAGE_ACCOUNTING_ROUTER');

export interface UsageAccountingRouter<Transaction, MonthlyUsageAccounting> {
  resolve(input: {
    orgId: string;
    integrationId: string;
    platformType: string;
  }):
    | {
        kind: 'standalone_credits';
        accounting: CreditAccountingPort<Transaction>;
      }
    | { kind: 'monthly_usage'; accounting: MonthlyUsageAccounting };
}
