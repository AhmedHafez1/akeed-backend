import {
  buildPurchaseReference,
  buildRequestHash,
  decodeCursor,
  encodeCursor,
  normalizeIdempotencyKey,
  paginate,
  priceQuantity,
  purchaseDenial,
  PURCHASE_REFERENCE_PATTERN,
  PurchaseQuantityError,
} from './billing.policy';
import { BILLING_ERROR_CODES, type PurchasePricing } from './billing.types';

const pricing: PurchasePricing = {
  priceMinor: 200,
  purchaseMin: 100,
  purchaseMax: 5000,
  purchaseStep: 50,
  lowBalanceThreshold: 10,
};

describe('priceQuantity', () => {
  it.each([100, 150, 5000])('prices %d credits from configuration', (q) => {
    expect(priceQuantity(q, pricing)).toEqual({
      quantity: q,
      unitPriceMinor: 200,
      totalMinor: q * 200,
      currency: 'EGP',
    });
  });

  it.each([
    [99, 'between'],
    [5050, 'between'],
    [125, 'multiple'],
    [0, 'between'],
    [-100, 'between'],
    [100.5, 'whole number'],
    [Number.MAX_SAFE_INTEGER, 'between'],
    [Number.POSITIVE_INFINITY, 'whole number'],
  ])('refuses %p', (quantity, detail) => {
    expect(() => priceQuantity(quantity, pricing)).toThrow(
      PurchaseQuantityError,
    );
    let thrown: unknown;
    try {
      priceQuantity(quantity, pricing);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as PurchaseQuantityError).detail).toContain(detail);
  });

  it('refuses a total no integer column could hold, even inside the bounds', () => {
    // A misconfigured price is still configuration; the product is what
    // actually reaches the database, so it is checked where it is computed.
    expect(() =>
      priceQuantity(5000, { ...pricing, priceMinor: 1_000_000 }),
    ).toThrow('exceeds the payable amount');
  });
});

describe('purchaseDenial', () => {
  const base = {
    enabled: true,
    platformType: 'standalone',
    role: 'owner' as const,
    summary: { status: 'active' as const },
  };

  it('allows an owner on an active Standalone account', () => {
    expect(purchaseDenial(base)).toBeNull();
  });

  it('allows an admin', () => {
    expect(purchaseDenial({ ...base, role: 'admin' })).toBeNull();
  });

  it.each([
    [{ enabled: false }, BILLING_ERROR_CODES.disabled],
    [{ platformType: 'shopify' }, BILLING_ERROR_CODES.sourceUnsupported],
    [{ platformType: null }, BILLING_ERROR_CODES.sourceUnsupported],
    [{ role: 'viewer' as const }, BILLING_ERROR_CODES.roleRequired],
    [{ role: null }, BILLING_ERROR_CODES.roleRequired],
    [{ summary: undefined }, BILLING_ERROR_CODES.accountNotProvisioned],
    [
      { summary: { status: 'suspended' as const } },
      BILLING_ERROR_CODES.accountSuspended,
    ],
  ])('denies %p with the expected code', (override, code) => {
    expect(purchaseDenial({ ...base, ...override })).toBe(code);
  });

  it('still allows a purchase at zero balance and in debt', () => {
    // Those states are exactly why a merchant is buying. They block sends, not
    // top-ups, so they must never close the till.
    expect(purchaseDenial(base)).toBeNull();
  });
});

describe('purchase identity', () => {
  it('mints opaque references that match the route pattern', () => {
    const reference = buildPurchaseReference();
    expect(reference).toMatch(PURCHASE_REFERENCE_PATTERN);
    expect(buildPurchaseReference()).not.toBe(reference);
  });

  it('binds an idempotency key to the terms it was first used with', () => {
    const terms = {
      orgId: 'org-1',
      quantity: 100,
      unitPriceMinor: 200,
      totalMinor: 20000,
      currency: 'EGP',
    };
    expect(buildRequestHash(terms)).toMatch(/^[a-f0-9]{64}$/);
    expect(buildRequestHash(terms)).toBe(buildRequestHash(terms));
    expect(buildRequestHash({ ...terms, quantity: 150 })).not.toBe(
      buildRequestHash(terms),
    );
    expect(buildRequestHash({ ...terms, orgId: 'org-2' })).not.toBe(
      buildRequestHash(terms),
    );
  });

  it.each(['abcdefgh', 'key.with:all-_chars', 'a'.repeat(128)])(
    'accepts %p as an idempotency key',
    (key) => {
      expect(normalizeIdempotencyKey(` ${key} `)).toBe(key);
    },
  );

  it.each([
    undefined,
    '',
    '   ',
    'short',
    'a'.repeat(129),
    'has space',
    'sla/sh',
  ])('refuses %p as an idempotency key', (key) => {
    expect(() => normalizeIdempotencyKey(key)).toThrow(PurchaseQuantityError);
  });
});

describe('history cursors', () => {
  const cursor = {
    createdAt: '2026-09-09T10:00:00.000Z',
    id: '4c0a6a3e-9d1f-4b2a-8f6c-1e2d3a4b5c6d',
  };

  it('round-trips', () => {
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it.each([
    ['undefined', undefined],
    ['not base64', '!!!!'],
    ['not json', Buffer.from('nope').toString('base64url')],
    ['wrong version', Buffer.from('{"v":2}').toString('base64url')],
    [
      'non-uuid id',
      Buffer.from(
        JSON.stringify({ v: 1, createdAt: cursor.createdAt, id: 'x' }),
      ).toString('base64url'),
    ],
    [
      'unparseable date',
      Buffer.from(
        JSON.stringify({ v: 1, createdAt: 'soon', id: cursor.id }),
      ).toString('base64url'),
    ],
  ])('rejects %s', (_label, value) => {
    expect(decodeCursor(value)).toBeNull();
  });

  it('emits a next cursor only when a further page exists', () => {
    const rows = [
      cursor,
      { ...cursor, id: '4c0a6a3e-9d1f-4b2a-8f6c-1e2d3a4b5c6e' },
    ];
    expect(paginate(rows, 2).nextCursor).toBeNull();
    const page = paginate(rows, 1);
    expect(page.items).toHaveLength(1);
    expect(decodeCursor(page.nextCursor ?? undefined)).toEqual(cursor);
  });
});
