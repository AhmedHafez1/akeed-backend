import type { CommerceOutcomeAction } from '../../../shared/commerce/commerce-outcome';
import { isRecord, WOOCOMMERCE_OUTCOME_META_KEY } from './woocommerce-delivery';

/**
 * The outcome mapping approved for building (US-07-01 contract record,
 * section 5). WooCommerce status names stay in this spoke.
 *
 * A confirmation writes the Akeed marker and one internal note and changes no
 * status: WooCommerce has no "confirmed", `processing` is where a placed COD
 * order already sits and `completed` means fulfilled. The two cancellations
 * write `cancelled` with the marker. Automatic no-reply and the tagging
 * actions have no entry: an unanswered message is never authority to cancel a
 * store order, and WooCommerce orders have no tags.
 */
export const WOOCOMMERCE_CANCELLED_STATUS = 'cancelled';

export interface WooCommerceOutcomeEffect {
  /** The status written with the marker; absent when none is. */
  status?: typeof WOOCOMMERCE_CANCELLED_STATUS;
  /** Whether one internal order note is added. */
  note: boolean;
}

const EFFECT_BY_ACTION: Partial<
  Record<CommerceOutcomeAction, WooCommerceOutcomeEffect>
> = {
  customer_confirmation: { note: true },
  customer_cancellation: { status: WOOCOMMERCE_CANCELLED_STATUS, note: false },
  merchant_no_reply_cancellation: {
    status: WOOCOMMERCE_CANCELLED_STATUS,
    note: false,
  },
};

export const WOOCOMMERCE_OUTCOME_ACTIONS = Object.keys(
  EFFECT_BY_ACTION,
) as CommerceOutcomeAction[];

/** The only statuses Akeed writes from (finding 5.16); any other is left. */
export const WOOCOMMERCE_WRITABLE_FROM_STATUSES: ReadonlySet<string> = new Set([
  'processing',
  'on-hold',
]);

/**
 * The confirmation note (finding 5.18): fixed, internal, no customer data.
 * It does not say who confirmed, because a merchant's own confirmation in
 * Akeed takes the same path as the customer's reply.
 */
export const WOOCOMMERCE_CONFIRMATION_NOTE =
  'Akeed: order confirmed. / أكيد: تم تأكيد الطلب.';

export function wooCommerceEffectFor(
  action: string,
): WooCommerceOutcomeEffect | undefined {
  return Object.prototype.hasOwnProperty.call(EFFECT_BY_ACTION, action)
    ? EFFECT_BY_ACTION[action as CommerceOutcomeAction]
    : undefined;
}

/** The value of the `akeed_outcome` meta entry (finding 5.17). */
export function buildWooCommerceOutcomeMarker(
  action: string,
  correlationId: string,
): string {
  return `${action}:${correlationId}`;
}

const STATUS_MAX_LENGTH = 64;
/** Printable ASCII without spaces: a status name, never free text. */
const STATUS_PATTERN = /^[\x21-\x7E]+$/;
const MARKER_MAX_LENGTH = 255;
const MARKERS_MAX = 20;

/** A status as the store names it, or null for anything that is not one. */
export function readWooCommerceStatus(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= STATUS_MAX_LENGTH &&
    STATUS_PATTERN.test(value)
    ? value
    : null;
}

/**
 * The values of every `akeed_outcome` entry in an order's `meta_data`.
 * Whether a repeated key adds an entry or replaces one is not documented
 * (finding 5.3), so all of them are read and any one may match.
 */
export function readWooCommerceOutcomeMarkers(metaData: unknown): string[] {
  if (!Array.isArray(metaData)) return [];
  const markers: string[] = [];
  for (const entry of metaData as unknown[]) {
    if (markers.length >= MARKERS_MAX) break;
    if (
      isRecord(entry) &&
      entry.key === WOOCOMMERCE_OUTCOME_META_KEY &&
      typeof entry.value === 'string' &&
      entry.value.length <= MARKER_MAX_LENGTH
    )
      markers.push(entry.value);
  }
  return markers;
}

/**
 * Whether a status is one the write for this action could have left: the
 * status a cancellation writes, or, for a confirmation that changes none, a
 * status it may be written from. Used to tell Akeed's own write coming back
 * from a change the merchant made afterwards.
 */
export function isStatusLeftByWooCommerceOutcome(
  action: string,
  status: string,
): boolean {
  const effect = wooCommerceEffectFor(action);
  if (!effect) return false;
  return effect.status
    ? status === effect.status
    : WOOCOMMERCE_WRITABLE_FROM_STATUSES.has(status);
}
