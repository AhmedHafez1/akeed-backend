import type {
  ReviewPromptClosedAction,
  ReviewPromptMerchantAction,
  ReviewPromptRequestStatus,
} from './review-prompt.types';

/**
 * What a merchant answer does to a request. The first answer closes it; the
 * same answer again (a double click, a retry after a lost response) is a
 * replay; any other answer to a closed request is refused, so one request is
 * never answered twice.
 */
export type MerchantActionDecision = 'record' | 'replay' | 'conflict';

export function decideMerchantAction(
  request: {
    status: ReviewPromptRequestStatus;
    closedAction: ReviewPromptClosedAction | null;
  },
  action: ReviewPromptMerchantAction,
): MerchantActionDecision {
  if (request.status === 'pending') return 'record';
  if (request.status === 'answered' && request.closedAction === action) {
    return 'replay';
  }
  return 'conflict';
}

/**
 * Whether staff can open a request for a store. Only Shopify stores are
 * asked, a store that answered "Don't ask again" is never asked again, and an
 * open request is left as it is.
 */
export type AdminEnableDecision =
  | 'create'
  | 'already_pending'
  | 'opted_out'
  | 'unsupported_platform';

export function decideAdminEnable(store: {
  platformType: string;
  optedOut: boolean;
  hasPending: boolean;
}): AdminEnableDecision {
  if (store.platformType !== 'shopify') return 'unsupported_platform';
  if (store.optedOut) return 'opted_out';
  if (store.hasPending) return 'already_pending';
  return 'create';
}
