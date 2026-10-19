import {
  decideAdminEnable,
  decideMerchantEvent,
  effectiveReviewPromptState,
  reviewPromptVariantFor,
  type ReviewPromptStateRow,
} from './review-prompt.policy';
import type {
  ReviewPromptState,
  ReviewRequestCode,
} from './review-prompt.types';

const NOW = new Date('2026-10-19T12:00:00.000Z');
const LATER = '2026-10-25T12:00:00.000Z';
const EARLIER = '2026-10-18T12:00:00.000Z';

function row(
  state: ReviewPromptState,
  extra: Partial<ReviewPromptStateRow> = {},
): ReviewPromptStateRow {
  return { state, snoozedUntil: null, snoozeCount: 0, ...extra };
}

describe('effectiveReviewPromptState', () => {
  it('treats a store with no row as eligible', () => {
    expect(effectiveReviewPromptState(undefined, NOW)).toBe('eligible');
  });

  it('keeps a running snooze', () => {
    expect(
      effectiveReviewPromptState(row('snoozed', { snoozedUntil: LATER }), NOW),
    ).toBe('snoozed');
  });

  it('makes an expired snooze eligible again', () => {
    expect(
      effectiveReviewPromptState(
        row('snoozed', { snoozedUntil: EARLIER }),
        NOW,
      ),
    ).toBe('eligible');
  });

  it.each<ReviewPromptState>([
    'declined',
    'clicked',
    'reviewed_prompted',
    'reviewed',
    'ineligible',
  ])('keeps %s as it is', (state) => {
    expect(effectiveReviewPromptState(row(state), NOW)).toBe(state);
  });
});

describe('decideMerchantEvent', () => {
  it('counts an impression of an eligible prompt', () => {
    expect(decideMerchantEvent(undefined, 'shown', NOW)).toEqual({
      kind: 'apply',
      change: { shown: true, event: 'shown' },
    });
  });

  it.each<ReviewPromptState>(['clicked', 'declined', 'reviewed'])(
    'ignores an impression while %s',
    (state) => {
      expect(decideMerchantEvent(row(state), 'shown', NOW)).toEqual({
        kind: 'replay',
      });
    },
  );

  it('records the CTA click as clicked', () => {
    expect(decideMerchantEvent(row('eligible'), 'clicked', NOW)).toEqual({
      kind: 'apply',
      change: { state: 'clicked', snoozedUntil: null, event: 'clicked' },
    });
  });

  it.each<[ReviewRequestCode, ReviewPromptState]>([
    ['success', 'reviewed_prompted'],
    ['already-reviewed', 'reviewed'],
    ['merchant-ineligible', 'ineligible'],
    ['cooldown-period', 'clicked'],
    ['annual-limit-reached', 'clicked'],
    ['mobile-app', 'clicked'],
    ['recently-installed', 'clicked'],
    ['unavailable', 'clicked'],
    ['cancelled', 'clicked'],
  ])('moves a %s result to %s', (code, state) => {
    expect(decideMerchantEvent(row('clicked'), 'result', NOW, code)).toEqual({
      kind: 'apply',
      change: {
        state,
        snoozedUntil: null,
        lastResultCode: code,
        event: 'result',
      },
    });
  });

  it.each<ReviewRequestCode>(['already-open', 'open-in-progress'])(
    'logs a %s result without changing the state',
    (code) => {
      expect(decideMerchantEvent(row('clicked'), 'result', NOW, code)).toEqual({
        kind: 'apply',
        change: { lastResultCode: code, event: 'result' },
      });
    },
  );

  it('ignores a result without a code', () => {
    expect(decideMerchantEvent(row('clicked'), 'result', NOW)).toEqual({
      kind: 'replay',
    });
  });

  it('snoozes the first "Not now" for 14 days', () => {
    expect(decideMerchantEvent(undefined, 'not_now', NOW)).toEqual({
      kind: 'apply',
      change: {
        state: 'snoozed',
        snoozedUntil: '2026-11-02T12:00:00.000Z',
        snoozeCount: 1,
        event: 'snoozed',
      },
    });
  });

  it('declines on the second "Not now" after the snooze ran out', () => {
    expect(
      decideMerchantEvent(
        row('snoozed', { snoozedUntil: EARLIER, snoozeCount: 1 }),
        'not_now',
        NOW,
      ),
    ).toEqual({
      kind: 'apply',
      change: {
        state: 'declined',
        snoozedUntil: null,
        snoozeCount: 2,
        event: 'declined',
      },
    });
  });

  it('replays a second "Not now" while the snooze is running', () => {
    expect(
      decideMerchantEvent(
        row('snoozed', { snoozedUntil: LATER, snoozeCount: 1 }),
        'not_now',
        NOW,
      ),
    ).toEqual({ kind: 'replay' });
  });

  it('replays "Not now" on a declined prompt', () => {
    expect(
      decideMerchantEvent(row('declined', { snoozeCount: 2 }), 'not_now', NOW),
    ).toEqual({ kind: 'replay' });
  });
});

describe('reviewPromptVariantFor', () => {
  it.each<[number | null, string]>([
    [null, 'fallback'],
    [0, 'fallback'],
    [9, 'fallback'],
    [10, 'results'],
    [128, 'results'],
  ])('gives %s confirmations the %s variant', (confirmed, variant) => {
    expect(reviewPromptVariantFor(confirmed)).toBe(variant);
  });
});

describe('decideAdminEnable', () => {
  it.each([
    [{ platformType: 'shopify', optedOut: false, hasPending: false }, 'create'],
    [
      { platformType: 'shopify', optedOut: false, hasPending: true },
      'already_pending',
    ],
    [
      { platformType: 'shopify', optedOut: true, hasPending: false },
      'opted_out',
    ],
    [
      { platformType: 'woocommerce', optedOut: false, hasPending: false },
      'unsupported_platform',
    ],
  ])('decides %o as %s', (store, decision) => {
    expect(decideAdminEnable(store)).toBe(decision);
  });
});
