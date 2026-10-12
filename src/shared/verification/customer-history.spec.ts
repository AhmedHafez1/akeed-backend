import { resolveCustomerHistory } from './customer-history';

describe('resolveCustomerHistory', () => {
  it('reads a first order as no other orders', () => {
    expect(
      resolveCustomerHistory(
        { orders: 1, confirmed: 1, canceled: 0, noReply: 0 },
        { status: 'confirmed', countsItself: true },
      ),
    ).toEqual({ other_orders: 0, confirmed: 0, canceled: 0, no_reply: 0 });
  });

  it('takes only the row itself out of the totals', () => {
    expect(
      resolveCustomerHistory(
        { orders: 5, confirmed: 3, canceled: 1, noReply: 1 },
        { status: 'canceled', countsItself: true },
      ),
    ).toEqual({ other_orders: 4, confirmed: 3, canceled: 0, no_reply: 1 });
  });

  it('subtracts nothing for a row the totals never counted', () => {
    expect(
      resolveCustomerHistory(
        { orders: 2, confirmed: 1, canceled: 1, noReply: 0 },
        { status: 'awaiting_start', countsItself: false },
      ),
    ).toEqual({ other_orders: 2, confirmed: 1, canceled: 1, no_reply: 0 });
  });

  it('never goes below zero when the phone has no totals', () => {
    expect(
      resolveCustomerHistory(undefined, {
        status: 'sent',
        countsItself: true,
      }),
    ).toEqual({ other_orders: 0, confirmed: 0, canceled: 0, no_reply: 0 });
  });
});
