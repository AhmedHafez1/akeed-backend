/**
 * A customer's track record with one merchant, as shown beside an order.
 *
 * A customer is a phone number. The counts describe the customer's other real
 * orders, so a first order reads as "new" rather than as a history of one.
 */

export interface CustomerHistory {
  other_orders: number;
  confirmed: number;
  canceled: number;
  no_reply: number;
}

export interface CustomerOrderTotals {
  orders: number;
  confirmed: number;
  canceled: number;
  noReply: number;
}

/**
 * The phone's totals with the row's own order taken out.
 *
 * `countsItself` is false for rows the totals never included (a held order has
 * no verification yet), so nothing is subtracted for them.
 */
export function resolveCustomerHistory(
  totals: CustomerOrderTotals | undefined,
  own: { status: string | null; countsItself: boolean },
): CustomerHistory {
  const self = own.countsItself ? 1 : 0;
  const minus = (value: number, status: string) =>
    Math.max(value - (self === 1 && own.status === status ? 1 : 0), 0);
  return {
    other_orders: Math.max((totals?.orders ?? 0) - self, 0),
    confirmed: minus(totals?.confirmed ?? 0, 'confirmed'),
    canceled: minus(totals?.canceled ?? 0, 'canceled'),
    no_reply: minus(totals?.noReply ?? 0, 'no_reply'),
  };
}
