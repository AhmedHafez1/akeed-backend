import {
  detectShopifyShipping,
  isShopifyOrderFulfilled,
  parseShopifyTags,
  projectShopifyOrderUpdate,
  readShopifyOrderRef,
  readShopifyTracking,
} from './shopify-shipping-event.mapper';

const ON = { fulfillmentTriggerEnabled: true, tags: [] as string[] };

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: '820982911946154508',
    created_at: '2026-11-20T10:00:00+02:00',
    cancelled_at: null,
    test: false,
    tags: '',
    fulfillment_status: null,
    fulfillments: [],
    ...overrides,
  };
}

describe('Shopify fulfillment detection', () => {
  it.each([
    ['fulfilled', true],
    ['partial', true],
    ['FULFILLED', true],
    ['restocked', false],
    [null, false],
    [undefined, false],
  ])('fulfillment_status %p → %p', (status, expected) => {
    expect(isShopifyOrderFulfilled(order({ fulfillment_status: status }))).toBe(
      expected,
    );
  });

  it('counts a live fulfillment even without a fulfillment status', () => {
    expect(
      isShopifyOrderFulfilled(order({ fulfillments: [{ status: 'success' }] })),
    ).toBe(true);
    expect(isShopifyOrderFulfilled(order({ fulfillments: [{ id: 1 }] }))).toBe(
      true,
    );
  });

  it('ignores fulfillments that were cancelled or failed', () => {
    expect(
      isShopifyOrderFulfilled(
        order({
          fulfillments: [
            { status: 'cancelled' },
            { status: 'error' },
            { status: 'failure' },
          ],
        }),
      ),
    ).toBe(false);
  });

  it('ignores a malformed fulfillments field', () => {
    expect(isShopifyOrderFulfilled(order({ fulfillments: 'x' }))).toBe(false);
    expect(isShopifyOrderFulfilled(order({ fulfillments: [null, 3] }))).toBe(
      false,
    );
  });
});

describe('Shopify tracking', () => {
  it('takes the first live fulfillment with a number or a link', () => {
    expect(
      readShopifyTracking(
        order({
          fulfillments: [
            { status: 'cancelled', tracking_number: 'OLD' },
            { status: 'success', tracking_number: null, tracking_urls: [] },
            {
              status: 'success',
              tracking_number: ' 1Z999 ',
              tracking_url: 'https://track.example/1Z999',
            },
          ],
        }),
      ),
    ).toEqual({ number: '1Z999', url: 'https://track.example/1Z999' });
  });

  it('reads the list spellings', () => {
    expect(
      readShopifyTracking(
        order({
          fulfillments: [
            {
              tracking_numbers: ['', 'AB12'],
              tracking_urls: ['https://t.example/AB12'],
            },
          ],
        }),
      ),
    ).toEqual({ number: 'AB12', url: 'https://t.example/AB12' });
  });

  it.each([
    'http://track.example/1',
    'javascript:alert(1)',
    'not a url',
    `https://t.example/${'a'.repeat(2048)}`,
  ])('drops the unsafe link %s and keeps the number', (url) => {
    expect(
      readShopifyTracking(
        order({ fulfillments: [{ tracking_number: 'N1', tracking_url: url }] }),
      ),
    ).toEqual({ number: 'N1' });
  });

  it('has no tracking when nothing is usable', () => {
    expect(
      readShopifyTracking(
        order({ fulfillments: [{ tracking_url: 'http://x.example' }] }),
      ),
    ).toBeUndefined();
    expect(readShopifyTracking(order())).toBeUndefined();
  });
});

describe('Shopify tags', () => {
  it('splits the comma-separated string and accepts a list', () => {
    expect(parseShopifyTags('vip, شحن ,  , Akeed: Verified')).toEqual([
      'vip',
      'شحن',
      'Akeed: Verified',
    ]);
    expect(parseShopifyTags(['a', ' b ', 3])).toEqual(['a', 'b']);
    expect(parseShopifyTags(null)).toEqual([]);
  });
});

describe('detectShopifyShipping', () => {
  it('detects a fulfillment with its tracking', () => {
    expect(
      detectShopifyShipping(
        order({
          fulfillment_status: 'fulfilled',
          fulfillments: [{ tracking_number: 'N1' }],
        }),
        ON,
      ),
    ).toEqual({
      stage: 'shipped',
      trigger: 'fulfillment',
      tracking: { number: 'N1' },
    });
  });

  it('ignores a fulfillment when the trigger is off', () => {
    expect(
      detectShopifyShipping(order({ fulfillment_status: 'fulfilled' }), {
        fulfillmentTriggerEnabled: false,
        tags: [],
      }),
    ).toBeNull();
  });

  it('detects a saved tag in any case or script', () => {
    expect(
      detectShopifyShipping(order({ tags: 'VIP, SHIPPED' }), {
        fulfillmentTriggerEnabled: false,
        tags: ['Shipped'],
      }),
    ).toEqual({ stage: 'shipped', trigger: 'tag', matchedTag: 'Shipped' });
    expect(
      detectShopifyShipping(order({ tags: 'تم الشحن' }), {
        fulfillmentTriggerEnabled: true,
        tags: ['تم الشحن'],
      }),
    ).toMatchObject({ trigger: 'tag', matchedTag: 'تم الشحن' });
  });

  it("never treats Akeed's own tags as a signal", () => {
    expect(
      detectShopifyShipping(
        order({ tags: 'Akeed: Verified, Akeed: Change Requested' }),
        { fulfillmentTriggerEnabled: true, tags: ['Akeed: Verified'] },
      ),
    ).toBeNull();
  });

  it('prefers the fulfillment when both apply', () => {
    expect(
      detectShopifyShipping(
        order({ fulfillment_status: 'partial', tags: 'shipped' }),
        { fulfillmentTriggerEnabled: true, tags: ['shipped'] },
      ),
    ).toEqual({ stage: 'shipped', trigger: 'fulfillment' });
  });

  it('returns null for an unshipped, untagged order', () => {
    expect(detectShopifyShipping(order({ tags: 'vip' }), ON)).toBeNull();
  });
});

describe('readShopifyOrderRef', () => {
  it('reads the id, dates and test flag', () => {
    expect(
      readShopifyOrderRef(
        order({ cancelled_at: '2026-11-21T08:00:00Z', test: true }),
      ),
    ).toEqual({
      externalOrderId: '820982911946154508',
      sourceCreatedAt: '2026-11-20T10:00:00+02:00',
      sourceCancelledAt: '2026-11-21T08:00:00Z',
      isTest: true,
    });
  });

  it('accepts a numeric id and drops unreadable dates', () => {
    expect(
      readShopifyOrderRef({ id: 450789469, created_at: 'yesterday' }),
    ).toEqual({
      externalOrderId: '450789469',
      sourceCreatedAt: null,
      sourceCancelledAt: null,
      isTest: false,
    });
  });

  it.each([undefined, '', 'gid://shopify/Order/1', -1, 1.5])(
    'returns null for the id %p',
    (id) => {
      expect(readShopifyOrderRef({ id })).toBeNull();
    },
  );
});

describe('projectShopifyOrderUpdate', () => {
  it('keeps only the fields shipping reads', () => {
    const projected = projectShopifyOrderUpdate({
      ...order({
        tags: 'shipped',
        fulfillment_status: 'fulfilled',
        fulfillments: [
          {
            status: 'success',
            tracking_number: 'N1',
            destination: { address1: '1 Street' },
            line_items: [{ name: 'Shoes' }],
          },
        ],
      }),
      customer: { phone: '+201000000000', email: 'a@example.com' },
      shipping_address: { address1: '1 Street' },
      phone: '+201000000000',
    });
    expect(projected).toEqual({
      id: '820982911946154508',
      created_at: '2026-11-20T10:00:00+02:00',
      updated_at: null,
      cancelled_at: null,
      test: false,
      tags: 'shipped',
      fulfillment_status: 'fulfilled',
      fulfillments: [{ status: 'success', tracking_number: 'N1' }],
    });
  });
});
