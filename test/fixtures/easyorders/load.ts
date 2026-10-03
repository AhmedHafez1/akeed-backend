import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface EasyOrdersOrderFixture {
  id: string;
  store_id: string;
  total_cost: number;
  full_name: string;
  phone: string;
  address: string;
  payment_method: string;
  [field: string]: unknown;
}

export interface EasyOrdersStatusFixture {
  event_type: string;
  order_id: string;
  old_status: string;
  new_status: string;
  [field: string]: unknown;
}

function payloadOf<T>(file: string): T {
  const fixture = JSON.parse(
    readFileSync(resolve(__dirname, file), 'utf8'),
  ) as { payload: T };
  return fixture.payload;
}

/** A fresh copy each call, so a test may change it. */
export function orderCreatedFixture(): EasyOrdersOrderFixture {
  return payloadOf<EasyOrdersOrderFixture>('order-created.json');
}

export function orderStatusFixture(): EasyOrdersStatusFixture {
  return payloadOf<EasyOrdersStatusFixture>('order-status-update.json');
}
