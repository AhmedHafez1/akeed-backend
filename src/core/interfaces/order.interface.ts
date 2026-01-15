export interface NormalizedOrder {
  orgId: string;
  externalOrderId: string; // The ID from Shopify/Salla
  orderNumber?: string;
  customerPhone: string; // Must be E.164 format
  customerName?: string;
  totalPrice: string;
  currency: string;
  rawPayload?: any; // Original webhook JSON
}
