import { integrations } from '../../infrastructure/database/schema';

export type IntegrationEligibilityInput = Pick<
  typeof integrations.$inferSelect,
  'platformType'
>;

export interface OrderEligibilityResult {
  eligible: boolean;
  reason:
    | 'cod_match'
    | 'non_cod_payment_method'
    | 'missing_payment_signal'
    | 'unsupported_platform';
  matchedSignal?: string;
}
