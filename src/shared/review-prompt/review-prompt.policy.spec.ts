import {
  decideAdminEnable,
  decideMerchantAction,
} from './review-prompt.policy';
import {
  REVIEW_PROMPT_MERCHANT_ACTIONS,
  type ReviewPromptMerchantAction,
} from './review-prompt.types';

describe('decideMerchantAction', () => {
  it.each(REVIEW_PROMPT_MERCHANT_ACTIONS)(
    'records %s on a pending request',
    (action) => {
      expect(
        decideMerchantAction({ status: 'pending', closedAction: null }, action),
      ).toBe('record');
    },
  );

  it.each(REVIEW_PROMPT_MERCHANT_ACTIONS)(
    'replays %s when the request was closed by the same answer',
    (action) => {
      expect(
        decideMerchantAction(
          { status: 'answered', closedAction: action },
          action,
        ),
      ).toBe('replay');
    },
  );

  it.each<[ReviewPromptMerchantAction, ReviewPromptMerchantAction]>([
    ['snoozed', 'dont_ask_again'],
    ['dismissed', 'review_clicked'],
    ['review_clicked', 'snoozed'],
    ['dont_ask_again', 'dismissed'],
  ])('refuses %s then %s', (first, second) => {
    expect(
      decideMerchantAction({ status: 'answered', closedAction: first }, second),
    ).toBe('conflict');
  });

  it('refuses an answer after staff switched the request off', () => {
    expect(
      decideMerchantAction(
        { status: 'admin_disabled', closedAction: 'admin_disabled' },
        'snoozed',
      ),
    ).toBe('conflict');
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
      { platformType: 'standalone', optedOut: false, hasPending: false },
      'unsupported_platform',
    ],
    [
      { platformType: 'woocommerce', optedOut: true, hasPending: false },
      'unsupported_platform',
    ],
  ] as const)('%o -> %s', (store, expected) => {
    expect(decideAdminEnable(store)).toBe(expected);
  });
});
