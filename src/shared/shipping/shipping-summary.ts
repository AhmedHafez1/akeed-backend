import {
  DELIVERY_REQUEST_REPLIES,
  type ShippingCustomerReply,
  type ShippingFailureReason,
  type ShippingNotificationStatus,
  type ShippingTrigger,
} from './shipping-notification.types';

/** The stored record, as far as a summary needs it. */
export interface ShippingRecordFields {
  verificationId: string;
  status: ShippingNotificationStatus;
  reasonCode: ShippingFailureReason | null;
  trigger: ShippingTrigger;
  matchedTag: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  customerReply: ShippingCustomerReply | null;
  customerRepliedAt: string | null;
  needsActionResolvedAt: string | null;
  updatedAt: string;
}

export interface ShippingSummary {
  status: ShippingNotificationStatus;
  reason_code: ShippingFailureReason | null;
  trigger: ShippingTrigger;
  matched_tag: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  customer_reply: ShippingCustomerReply | null;
  customer_replied_at: string | null;
  delivery_request: boolean;
  resolved_at: string | null;
  updated_at: string;
}

/** What the merchant sees about an order's Shipped message. */
export function toShippingSummary(row: ShippingRecordFields): ShippingSummary {
  return {
    status: row.status,
    reason_code: row.reasonCode,
    trigger: row.trigger,
    matched_tag: row.matchedTag,
    tracking_number: row.trackingNumber,
    tracking_url: row.trackingUrl,
    customer_reply: row.customerReply,
    customer_replied_at: row.customerRepliedAt,
    delivery_request:
      row.customerReply !== null &&
      DELIVERY_REQUEST_REPLIES.includes(row.customerReply) &&
      row.needsActionResolvedAt === null,
    resolved_at: row.needsActionResolvedAt,
    updated_at: row.updatedAt,
  };
}
