import { integrations } from '../../infrastructure/database/schema';

export type IntegrationEligibilityInput = Pick<
  typeof integrations.$inferSelect,
  'platformType'
> &
  Partial<
    Pick<typeof integrations.$inferSelect, 'assumeCodWhenPaymentMissing'>
  >;

export interface OrderEligibilityResult {
  eligible: boolean;
  reason:
    | 'cod_match'
    /** A spoke counted an unpaid order on a generic manual gateway as COD. */
    | 'manual_unpaid_cod'
    | 'non_cod_payment_method'
    | 'missing_payment_signal'
    | 'merchant_cod_default'
    | 'unsupported_platform';
  matchedSignal?: string;
}
