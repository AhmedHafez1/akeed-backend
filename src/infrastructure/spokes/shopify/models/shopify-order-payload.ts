export interface ShopifyAddress {
  phone?: string;
  first_name?: string;
  last_name?: string;
}

export interface ShopifyCustomer {
  id: number;
  first_name?: string;
  last_name?: string;
  phone?: string;
  default_address?: ShopifyAddress | null;
}

export interface ShopifyOrderPayload {
  id: number;
  order_number?: number;
  phone?: string;
  gateway?: string;
  payment_gateway_names?: string[];
  customer?: ShopifyCustomer | null;
  billing_address?: ShopifyAddress | null;
  shipping_address?: ShopifyAddress | null;
  total_price: string;
  currency: string;
  [key: string]: any;
}
