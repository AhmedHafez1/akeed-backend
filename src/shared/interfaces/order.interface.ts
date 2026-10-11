import type { CodStatus } from './commerce-source.interface';

/** One product line of an order, as the source delivered it. */
export interface OrderLineItem {
  name: string;
  quantity: number;
  /** Decimal unit price as text; null when the source gave none. */
  unitPrice: string | null;
  /** Variant choices such as colour or size. `name` may be unknown. */
  options: { name?: string; value: string }[];
}

/** How many lines of an order are kept. */
export const ORDER_LINE_ITEMS_MAX = 50;

export interface NormalizedOrder {
  /** Trusted tenant identity resolved by the ingestion boundary. */
  orgId: string;
  /** Trusted commerce-source identity resolved by the ingestion boundary. */
  integrationId: string;
  /** Stable order identifier assigned by the source. */
  externalOrderId: string;
  /** Optional merchant-facing source reference. */
  orderNumber?: string;
  /** Customer phone number in E.164 format. */
  customerPhone: string;
  customerName?: string;
  /** Decimal monetary amount represented as text. */
  totalPrice: string;
  /** Source currency code. */
  currency: string;
  paymentMethod?: string;
  /** Normalized payment evidence collected at the source boundary. */
  paymentSignals?: string[];
  /** Explicit COD disposition; omitted by legacy producers. */
  codStatus?: CodStatus;
  /** What was ordered. Omitted by a source that does not deliver it. */
  lineItems?: OrderLineItem[];
  /** The governorate of the delivery address, else its city. */
  shippingRegion?: string;
  /** The street address of the delivery. */
  shippingAddress?: string;
  /** Opaque provider payload. Platform-specific code owns its interpretation. */
  rawPayload?: Record<string, unknown>;
}
