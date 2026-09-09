import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildPaymobHmacSource,
  MalformedPaymobCallbackError,
  normalizePaymobValue,
  PAYMOB_HMAC_FIELDS,
  signPaymobPayload,
  verifyPaymobHmac,
} from './paymob-hmac';

const SECRET = 'sandbox-hmac-secret';
const FIXTURES = join(__dirname, 'fixtures');

interface Fixture {
  provenance: 'synthetic' | 'sandbox-capture';
  capturedAt: string | null;
  query: { hmac: string | null };
  body: { type: string; obj: Record<string, unknown> };
}

function load(name: string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Fixture;
}

const fixtureNames = readdirSync(FIXTURES).filter((name) =>
  name.endsWith('.json'),
);
const transactions = fixtureNames.filter((name) =>
  name.startsWith('transaction.'),
);

/**
 * The documented concatenation, written out longhand.
 *
 * Deliberately not derived from `PAYMOB_HMAC_FIELDS`: a test that reads the
 * same list the implementation reads proves only that the code is
 * self-consistent. This is the second, independent statement of Paymob's order,
 * so reordering the production list fails here.
 */
function referenceSource(o: Record<string, unknown>): string {
  const order = o.order as Record<string, unknown> | number;
  const src = (o.source_data ?? {}) as Record<string, unknown>;
  const bool = (v: unknown) => (v ? 'true' : 'false');
  const text = (v: string | number | null | undefined) =>
    v === null || v === undefined ? '' : String(v);
  return (
    String(o.amount_cents) +
    String(o.created_at) +
    String(o.currency) +
    bool(o.error_occured) +
    bool(o.has_parent_transaction) +
    String(o.id) +
    String(o.integration_id) +
    bool(o.is_3d_secure) +
    bool(o.is_auth) +
    bool(o.is_capture) +
    bool(o.is_refunded) +
    bool(o.is_standalone_payment) +
    bool(o.is_voided) +
    String(typeof order === 'object' ? order.id : order) +
    text(o.owner as number | null) +
    bool(o.pending) +
    text(src.pan as string | null) +
    text(src.sub_type as string | null) +
    text(src.type as string | null) +
    bool(o.success)
  );
}

describe('buildPaymobHmacSource', () => {
  it('signs exactly twenty fields', () => {
    expect(PAYMOB_HMAC_FIELDS).toHaveLength(20);
    expect(new Set(PAYMOB_HMAC_FIELDS).size).toBe(20);
  });

  it.each(transactions)(
    '%s matches an independent statement of the documented order',
    (name) => {
      const { body } = load(name);
      expect(buildPaymobHmacSource(body.obj)).toBe(referenceSource(body.obj));
    },
  );

  it('resolves a nested order object and a bare order id identically', () => {
    const nested = load('transaction.card-success.json').body.obj;
    const bare = { ...nested, order: (nested.order as { id: number }).id };
    expect(buildPaymobHmacSource(bare)).toBe(buildPaymobHmacSource(nested));
  });

  it('signs values, not serialization, so reordered JSON keys still verify', () => {
    const { obj } = load('transaction.card-success.json').body;
    const reordered = Object.fromEntries(
      Object.entries(obj).reverse(),
    ) as Record<string, unknown>;
    const digest = signPaymobPayload(obj, SECRET);
    expect(verifyPaymobHmac(reordered, digest, SECRET)).toBe(true);
  });

  it('ignores fields outside the signed list', () => {
    const { obj } = load('transaction.card-success.json').body;
    expect(
      buildPaymobHmacSource({ ...obj, unexpected_field: 'anything' }),
    ).toBe(buildPaymobHmacSource(obj));
  });

  it('treats an absent owner and source_data as empty strings', () => {
    const { obj } = load('transaction.null-source-data.json').body;
    expect(() => buildPaymobHmacSource(obj)).not.toThrow();
    const withoutBoth = { ...obj };
    delete withoutBoth.source_data;
    delete withoutBoth.owner;
    expect(buildPaymobHmacSource(withoutBoth)).toBe(buildPaymobHmacSource(obj));
  });

  it.each([
    'amount_cents',
    'created_at',
    'currency',
    'id',
    'integration_id',
    'pending',
    'success',
  ])('refuses a payload missing the required field %s', (field) => {
    const { obj } = load('transaction.card-success.json').body;
    const truncated = { ...obj };
    delete truncated[field];
    expect(() => buildPaymobHmacSource(truncated)).toThrow(
      MalformedPaymobCallbackError,
    );
  });

  it('refuses a payload missing order.id', () => {
    const { obj } = load('transaction.card-success.json').body;
    expect(() => buildPaymobHmacSource({ ...obj, order: {} })).toThrow(
      MalformedPaymobCallbackError,
    );
  });
});

describe('normalizePaymobValue', () => {
  it.each([
    [true, 'true'],
    [false, 'false'],
    [0, '0'],
    [20000, '20000'],
    ['EGP', 'EGP'],
    ['  spaced  ', '  spaced  '],
  ])('serializes %p as %p', (value, expected) => {
    expect(normalizePaymobValue(value, 'currency')).toBe(expected);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1e21])(
    'refuses %p, whose text form would change the signed bytes',
    (value) => {
      expect(() => normalizePaymobValue(value, 'amount_cents')).toThrow(
        MalformedPaymobCallbackError,
      );
    },
  );

  it.each([[{}], [[]]])('refuses the structured value %p', (value) => {
    expect(() => normalizePaymobValue(value, 'owner')).toThrow(
      MalformedPaymobCallbackError,
    );
  });
});

describe('verifyPaymobHmac', () => {
  const { obj } = load('transaction.card-success.json').body;
  const digest = signPaymobPayload(obj, SECRET);

  it('accepts the digest it produced', () => {
    expect(verifyPaymobHmac(obj, digest, SECRET)).toBe(true);
  });

  it('rejects a digest computed with a different secret', () => {
    expect(verifyPaymobHmac(obj, digest, 'other-secret')).toBe(false);
  });

  it('rejects a digest with a single flipped character', () => {
    const flipped = `${digest[0] === 'f' ? 'e' : 'f'}${digest.slice(1)}`;
    expect(verifyPaymobHmac(obj, flipped, SECRET)).toBe(false);
  });

  it('rejects a digest for a different amount', () => {
    expect(verifyPaymobHmac({ ...obj, amount_cents: 1 }, digest, SECRET)).toBe(
      false,
    );
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['non-string', 12345],
    ['uppercase hex', digest.toUpperCase()],
    ['too short', digest.slice(0, 127)],
    ['too long', `${digest}0`],
    ['not hex', 'z'.repeat(128)],
  ])(
    'rejects a %s digest by shape, before any comparison',
    (_label, received) => {
      // A wrong-length buffer makes `timingSafeEqual` throw, leaking through an
      // exception the very comparison it was chosen to hide. Returning false
      // rather than throwing is the assertion.
      expect(verifyPaymobHmac(obj, received, SECRET)).toBe(false);
    },
  );

  it.each(transactions)('rejects a well-formed wrong digest for %s', (name) => {
    const fixture = load(name);
    expect(verifyPaymobHmac(fixture.body.obj, 'a'.repeat(128), SECRET)).toBe(
      false,
    );
  });
});

/**
 * Real provider contract. Skipped until a sandbox capture and its secret exist;
 * see fixtures/README.md.
 */
describe('captured Paymob callbacks', () => {
  const captured = fixtureNames.filter(
    (name) => load(name).provenance === 'sandbox-capture',
  );
  const secret = process.env.PAYMOB_FIXTURE_HMAC_SECRET;

  it('verifies every captured fixture against its recorded digest', () => {
    if (!captured.length || !secret) {
      console.warn(
        'NOT RUN: no sandbox-capture fixtures, or PAYMOB_FIXTURE_HMAC_SECRET is unset.',
      );
      return;
    }
    for (const name of captured) {
      const fixture = load(name);
      expect(
        verifyPaymobHmac(fixture.body.obj, fixture.query.hmac, secret),
      ).toBe(true);
    }
  });
});

describe('signPaymobPayload', () => {
  it('produces a lowercase 128-character SHA-512 digest', () => {
    const { obj } = load('transaction.wallet-success.json').body;
    const digest = signPaymobPayload(obj, SECRET);
    expect(digest).toMatch(/^[a-f0-9]{128}$/);
    expect(digest).toBe(
      createHmac('sha512', SECRET)
        .update(buildPaymobHmacSource(obj), 'utf8')
        .digest('hex'),
    );
  });
});
