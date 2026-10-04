import { COMMERCE_OUTCOME_ACTIONS } from '../../../shared/commerce/commerce-outcome';
import {
  buildWooCommerceOutcomeMarker,
  isStatusLeftByWooCommerceOutcome,
  readWooCommerceOutcomeMarkers,
  readWooCommerceStatus,
  WOOCOMMERCE_CONFIRMATION_NOTE,
  WOOCOMMERCE_OUTCOME_ACTIONS,
  WOOCOMMERCE_WRITABLE_FROM_STATUSES,
  wooCommerceEffectFor,
} from './woocommerce-outcome.mapping';

describe('WooCommerce outcome mapping', () => {
  it('maps a confirmation to the marker and a note, with no status', () => {
    expect(wooCommerceEffectFor('customer_confirmation')).toEqual({
      note: true,
    });
  });

  it.each(['customer_cancellation', 'merchant_no_reply_cancellation'])(
    'maps %s to cancelled, with no note',
    (action) => {
      expect(wooCommerceEffectFor(action)).toEqual({
        status: 'cancelled',
        note: false,
      });
    },
  );

  it.each([
    'automatic_no_reply_tagging',
    'merchant_cancellation_tagging',
    'toString',
    '__proto__',
    '',
  ])('has no effect for %s', (action) => {
    expect(wooCommerceEffectFor(action)).toBeUndefined();
  });

  it('offers exactly the three approved actions', () => {
    expect([...WOOCOMMERCE_OUTCOME_ACTIONS].sort()).toEqual([
      'customer_cancellation',
      'customer_confirmation',
      'merchant_no_reply_cancellation',
    ]);
    expect(
      WOOCOMMERCE_OUTCOME_ACTIONS.every((action) =>
        COMMERCE_OUTCOME_ACTIONS.includes(action),
      ),
    ).toBe(true);
  });

  it('never writes a paid, processing or completed status', () => {
    const written = WOOCOMMERCE_OUTCOME_ACTIONS.map(
      (action) => wooCommerceEffectFor(action)?.status,
    ).filter(Boolean);

    expect(new Set(written)).toEqual(new Set(['cancelled']));
  });

  it('writes only from processing and on-hold', () => {
    expect([...WOOCOMMERCE_WRITABLE_FROM_STATUSES].sort()).toEqual([
      'on-hold',
      'processing',
    ]);
  });

  it('builds the marker from the action and the correlation', () => {
    expect(
      buildWooCommerceOutcomeMarker('customer_confirmation', 'verification-1'),
    ).toBe('customer_confirmation:verification-1');
  });

  it('keeps the note fixed and free of customer data', () => {
    expect(WOOCOMMERCE_CONFIRMATION_NOTE).toBe(
      'Akeed: order confirmed. / أكيد: تم تأكيد الطلب.',
    );
  });

  describe('readWooCommerceStatus', () => {
    it.each(['processing', 'on-hold', 'cancelled', 'wc-custom_status'])(
      'reads %s',
      (status) => {
        expect(readWooCommerceStatus(status)).toBe(status);
      },
    );

    it.each([
      ['nothing', undefined],
      ['a number', 7],
      ['an empty string', ''],
      ['free text', 'on its way'],
      ['more than 64 characters', 'x'.repeat(65)],
      ['non-ASCII text', 'ملغي'],
    ])('does not read %s as a status', (_label, value) => {
      expect(readWooCommerceStatus(value)).toBeNull();
    });
  });

  describe('readWooCommerceOutcomeMarkers', () => {
    it('reads every akeed_outcome entry and nothing else', () => {
      expect(
        readWooCommerceOutcomeMarkers([
          { id: 1, key: 'akeed_outcome', value: 'customer_confirmation:a' },
          { id: 2, key: '_billing_note', value: 'customer_confirmation:a' },
          { id: 3, key: 'akeed_outcome', value: 'customer_cancellation:a' },
          { id: 4, key: 'akeed_outcome', value: { nested: true } },
          { id: 5, key: 'akeed_outcome', value: 'x'.repeat(256) },
          'akeed_outcome',
          null,
        ]),
      ).toEqual(['customer_confirmation:a', 'customer_cancellation:a']);
    });

    it.each([undefined, null, 'akeed_outcome', { key: 'akeed_outcome' }])(
      'reads nothing from %p',
      (metaData) => {
        expect(readWooCommerceOutcomeMarkers(metaData)).toEqual([]);
      },
    );

    it('stops at twenty entries', () => {
      const metaData = Array.from({ length: 50 }, (_, index) => ({
        key: 'akeed_outcome',
        value: `customer_confirmation:${index}`,
      }));

      expect(readWooCommerceOutcomeMarkers(metaData)).toHaveLength(20);
    });
  });

  describe('isStatusLeftByWooCommerceOutcome', () => {
    it.each([
      ['customer_confirmation', 'processing', true],
      ['customer_confirmation', 'on-hold', true],
      ['customer_confirmation', 'completed', false],
      ['customer_confirmation', 'cancelled', false],
      ['customer_cancellation', 'cancelled', true],
      ['customer_cancellation', 'processing', false],
      ['merchant_no_reply_cancellation', 'cancelled', true],
      ['merchant_no_reply_cancellation', 'refunded', false],
      ['automatic_no_reply_tagging', 'cancelled', false],
      ['unknown_action', 'processing', false],
    ])('%s and %s: %s', (action, status, expected) => {
      expect(isStatusLeftByWooCommerceOutcome(action, status)).toBe(expected);
    });
  });
});
