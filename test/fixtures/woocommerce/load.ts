import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface WooCommerceOrderFixture {
  id: number;
  number: string;
  status: string;
  currency: string;
  date_created_gmt: string;
  date_modified_gmt: string;
  total: string;
  payment_method: string;
  billing: {
    first_name: string;
    last_name: string;
    phone: string;
    country: string;
    [field: string]: unknown;
  };
  meta_data: unknown[];
  [field: string]: unknown;
}

export interface WooCommerceDeliveryFixture {
  /** The delivery headers the fixture documents; never a signature. */
  headers: Record<string, string>;
  payload: WooCommerceOrderFixture;
}

/** A fresh copy each call, so a test may change it. */
function deliveryOf(file: string): WooCommerceDeliveryFixture {
  const fixture = JSON.parse(
    readFileSync(resolve(__dirname, file), 'utf8'),
  ) as {
    _fixture: { headers: Record<string, string> };
    payload: WooCommerceOrderFixture;
  };
  return { headers: fixture._fixture.headers, payload: fixture.payload };
}

export function checkoutDraftFixture(): WooCommerceDeliveryFixture {
  return deliveryOf('order-checkout-draft.json');
}

export function placedCodFixture(): WooCommerceDeliveryFixture {
  return deliveryOf('order-placed-cod.json');
}

export function placedNonCodFixture(): WooCommerceDeliveryFixture {
  return deliveryOf('order-placed-non-cod.json');
}

export function orderUpdatedFixture(): WooCommerceDeliveryFixture {
  return deliveryOf('order-updated.json');
}

/** The assumed ping body, without its trailing line break. */
export function pingFixture(): string {
  return readFileSync(resolve(__dirname, 'ping.txt'), 'utf8').trimEnd();
}
