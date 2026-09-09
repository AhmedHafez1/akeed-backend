import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PurchaseSignal } from '../../../shared/ports/payments.port';
import {
  mapPaymobCallback,
  paymobErrorCode,
  UnsupportedPaymobEventError,
} from './paymob-status.mapper';
import { PROVIDER_CODE_PATTERN } from '../../../modules/billing/billing.types';

const FIXTURES = join(__dirname, 'fixtures');

function body(name: string): { type: string; obj: Record<string, unknown> } {
  const fixture = JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as {
    body: { type: string; obj: Record<string, unknown> };
  };
  return fixture.body;
}

const map = (name: string) =>
  mapPaymobCallback(body(name), { source: 'callback', mode: 'test' });

describe('mapPaymobCallback', () => {
  it.each([
    ['transaction.card-success.json', 'success'],
    ['transaction.wallet-success.json', 'success'],
    ['transaction.declined.json', 'decline'],
    ['transaction.pending.json', 'pending'],
    ['transaction.voided.json', 'void'],
    ['transaction.refund-full.json', 'refund'],
    ['transaction.refund-partial-exact.json', 'refund'],
    ['transaction.refund-partial-odd.json', 'refund'],
  ] as [string, PurchaseSignal][])('reads %s as %s', (name, signal) => {
    expect(map(name).signal).toBe(signal);
  });

  it('carries the trusted amount, currency and integration through unchanged', () => {
    expect(map('transaction.card-success.json')).toMatchObject({
      provider: 'paymob',
      source: 'callback',
      mode: 'test',
      amountMinor: 20000,
      currency: 'EGP',
      integrationId: '4001001',
      reference: 'akd_1111111111111111111111111111aaaa',
      payment: { providerOrderId: '510001', providerTransactionId: '720001' },
    });
  });

  it('resolves the reference from a bare order id payload too', () => {
    expect(map('transaction.order-as-integer.json')).toMatchObject({
      reference: 'akd_99999999999999999999999999992222',
      payment: { providerOrderId: '510009' },
    });
  });

  it('reports the cumulative refunded amount, not the transaction amount', () => {
    expect(map('transaction.refund-partial-exact.json')).toMatchObject({
      refundedMinorTotal: 3000,
      sourceReference: '720007',
    });
    expect(map('transaction.refund-partial-odd.json').refundedMinorTotal).toBe(
      3050,
    );
    expect(map('transaction.refund-full.json').refundedMinorTotal).toBe(20000);
  });

  it('leaves refund fields unset for a plain success', () => {
    expect(map('transaction.card-success.json')).toMatchObject({
      refundedMinorTotal: undefined,
      sourceReference: undefined,
    });
  });

  it.each(['token.unsupported.json'])('refuses the %s envelope', (name) => {
    expect(() => map(name)).toThrow(UnsupportedPaymobEventError);
  });

  it('refuses a transaction with no resolvable Akeed reference', () => {
    const payload = body('transaction.card-success.json');
    const obj: Record<string, unknown> = {
      ...payload.obj,
      order: { id: 510001 },
    };
    delete obj.payment_key_claims;
    expect(() =>
      mapPaymobCallback(
        { type: 'TRANSACTION', obj },
        { source: 'callback', mode: 'test' },
      ),
    ).toThrow(UnsupportedPaymobEventError);
  });

  it.each(['amount_cents', 'currency', 'integration_id'])(
    'refuses a transaction with no %s to match against',
    (field) => {
      const payload = body('transaction.card-success.json');
      const obj = { ...payload.obj };
      delete obj[field];
      expect(() =>
        mapPaymobCallback(
          { type: 'TRANSACTION', obj },
          { source: 'callback', mode: 'test' },
        ),
      ).toThrow(UnsupportedPaymobEventError);
    },
  );
});

describe('fingerprints', () => {
  it('are stable for the same provider facts', () => {
    expect(map('transaction.card-success.json').fingerprint).toBe(
      map('transaction.card-success.json').fingerprint,
    );
  });

  it('ignore the arrival channel, so an inquiry replays a callback', () => {
    // This is what makes a lost-response recovery safe: whichever arrives
    // second collides on `payment_event_fingerprint_key` and grants nothing.
    const viaCallback = map('transaction.card-success.json');
    const viaInquiry = mapPaymobCallback(
      body('transaction.card-success.json'),
      {
        source: 'inquiry',
        mode: 'test',
      },
    );
    expect(viaInquiry.fingerprint).toBe(viaCallback.fingerprint);
    expect(viaInquiry.source).toBe('inquiry');
  });

  it.each([
    ['amount', { amount_cents: 19999 }],
    ['success flag', { success: false }],
    ['transaction id', { id: 999999 }],
    ['integration', { integration_id: 4001002 }],
    ['timestamp', { created_at: '2026-09-09T11:00:00.000000' }],
  ])('change when the %s changes', (_label, overrides) => {
    const payload = body('transaction.card-success.json');
    const changed = mapPaymobCallback(
      { type: 'TRANSACTION', obj: { ...payload.obj, ...overrides } },
      { source: 'callback', mode: 'test' },
    );
    expect(changed.fingerprint).not.toBe(
      map('transaction.card-success.json').fingerprint,
    );
  });

  it.each([
    'transaction.card-success.json',
    'transaction.refund-full.json',
    'transaction.declined.json',
  ])('are 64 hex characters for %s, as the column requires', (name) => {
    expect(map(name).fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(map(name).payloadHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('paymobErrorCode', () => {
  it('sanitizes a decline reason into the constrained column format', () => {
    expect(map('transaction.declined.json').errorCode).toMatch(
      PROVIDER_CODE_PATTERN,
    );
  });

  it.each([
    [{ data: { message: 'Insufficient Funds' } }, 'insufficient_funds'],
    [{ data: { txn_response_code: '51' } }, '51'],
    [{ data: { message: '  ***  ' } }, undefined],
    [{ data: {} }, undefined],
    [{}, undefined],
  ])('maps %p to %p', (transaction, expected) => {
    expect(paymobErrorCode(transaction as never)).toBe(expected);
  });

  it('truncates a long reason to the column width', () => {
    const code = paymobErrorCode({
      data: { message: 'a'.repeat(200) },
    } as never);
    expect(code).toHaveLength(80);
    expect(code).toMatch(PROVIDER_CODE_PATTERN);
  });
});
