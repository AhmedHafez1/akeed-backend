import type { CommerceOutcomeAction } from '../../../shared/commerce/commerce-outcome';

/**
 * The outcome mapping approved for building (contract record section 5).
 * EasyOrders status names stay in this spoke.
 *
 * Automatic no-reply and the two tagging actions have no entry: EasyOrders has
 * no tag concept, and an unanswered message is never authority to cancel a
 * store order. Only the merchant's own action maps to `canceled`.
 */
const STATUS_BY_ACTION: Partial<
  Record<CommerceOutcomeAction, 'confirmed' | 'canceled'>
> = {
  customer_confirmation: 'confirmed',
  customer_cancellation: 'canceled',
  merchant_no_reply_cancellation: 'canceled',
};

export const EASYORDERS_OUTCOME_ACTIONS = Object.keys(
  STATUS_BY_ACTION,
) as CommerceOutcomeAction[];

/** The only status Akeed writes from; anything else is left as it is. */
export const EASYORDERS_WRITABLE_FROM_STATUS = 'pending';

export function easyOrdersStatusFor(
  action: string,
): 'confirmed' | 'canceled' | undefined {
  return Object.prototype.hasOwnProperty.call(STATUS_BY_ACTION, action)
    ? STATUS_BY_ACTION[action as CommerceOutcomeAction]
    : undefined;
}

const STATUS_MAX_LENGTH = 64;
/** Printable ASCII without spaces: a status name, never free text. */
const STATUS_PATTERN = /^[\x21-\x7E]+$/;

/** A status as EasyOrders names it, or null for anything that is not one. */
export function readEasyOrdersStatus(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= STATUS_MAX_LENGTH &&
    STATUS_PATTERN.test(value)
    ? value
    : null;
}
