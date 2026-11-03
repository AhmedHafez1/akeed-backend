import type { InspectedBusinessToken } from './own-number-graph.client';
import {
  checkBusinessToken,
  choosePhoneNumber,
  chooseWabaId,
  signupPathFromHints,
  type SignupSessionHints,
} from './signup-assets.policy';

const APP = '999653349077771';
const WABA = '102290129340398';
const OTHER_WABA = '102290129340399';

const token = (
  overrides: Partial<InspectedBusinessToken> = {},
): InspectedBusinessToken => ({
  appId: APP,
  isValid: true,
  scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
  granularScopes: [
    { scope: 'whatsapp_business_management', targetIds: [WABA] },
    { scope: 'whatsapp_business_messaging', targetIds: [WABA] },
  ],
  ...overrides,
});

const hints = (
  overrides: Partial<SignupSessionHints> = {},
): SignupSessionHints => ({
  wabaIds: [],
  phoneNumberId: null,
  isOnBusinessApp: null,
  ...overrides,
});

describe('checkBusinessToken', () => {
  it('accepts a live token for this app with both WhatsApp scopes', () => {
    expect(checkBusinessToken(token(), APP)).toEqual({ ok: true });
  });

  it.each([
    ['invalid', token({ isValid: false })],
    ['app_mismatch', token({ appId: '111' })],
    ['app_mismatch', token({ appId: null })],
    ['missing_scope', token({ scopes: ['whatsapp_business_management'] })],
    ['missing_scope', token({ scopes: ['whatsapp_business_messaging'] })],
  ])('refuses as %s', (reason, inspected) => {
    expect(checkBusinessToken(inspected, APP)).toEqual({ ok: false, reason });
  });
});

describe('chooseWabaId', () => {
  it('takes the one account the token grants, with no hint', () => {
    expect(chooseWabaId(token(), hints())).toEqual({ ok: true, id: WABA });
  });

  it.each([
    ['v5 messaging_account_ids', hints({ wabaIds: [WABA] })],
    ['v4 waba_id', hints({ wabaIds: [WABA, WABA] })],
  ])('takes a %s hint the token grants', (_label, hint) => {
    expect(chooseWabaId(token(), hint)).toEqual({ ok: true, id: WABA });
  });

  it('refuses a hinted account the token does not grant', () => {
    expect(chooseWabaId(token(), hints({ wabaIds: [OTHER_WABA] }))).toEqual({
      ok: false,
      reason: 'unverified',
    });
  });

  it('needs both scopes on the same account', () => {
    const split = token({
      granularScopes: [
        { scope: 'whatsapp_business_management', targetIds: [WABA] },
        { scope: 'whatsapp_business_messaging', targetIds: [OTHER_WABA] },
      ],
    });
    expect(chooseWabaId(split, hints())).toEqual({
      ok: false,
      reason: 'unverified',
    });
  });

  it('never picks among several granted accounts without one hint', () => {
    const several = token({
      granularScopes: [
        {
          scope: 'whatsapp_business_management',
          targetIds: [WABA, OTHER_WABA],
        },
        { scope: 'whatsapp_business_messaging', targetIds: [WABA, OTHER_WABA] },
      ],
    });
    expect(chooseWabaId(several, hints())).toEqual({
      ok: false,
      reason: 'ambiguous',
    });
    expect(
      chooseWabaId(several, hints({ wabaIds: [WABA, OTHER_WABA] })),
    ).toEqual({ ok: false, reason: 'ambiguous' });
    expect(chooseWabaId(several, hints({ wabaIds: [OTHER_WABA] }))).toEqual({
      ok: true,
      id: OTHER_WABA,
    });
  });

  it('refuses a token that grants no account', () => {
    expect(chooseWabaId(token({ granularScopes: [] }), hints())).toEqual({
      ok: false,
      reason: 'unverified',
    });
  });
});

describe('choosePhoneNumber', () => {
  const one = { id: '1', displayPhoneNumber: '+20 1' };
  const two = { id: '2', displayPhoneNumber: '+20 2' };

  it('accepts a hinted number on the account’s list', () => {
    expect(choosePhoneNumber([one, two], '2')).toEqual({
      ok: true,
      phoneNumber: two,
    });
  });

  it('refuses a hinted number that is not on the list', () => {
    expect(choosePhoneNumber([one], '3')).toEqual({
      ok: false,
      reason: 'unverified',
    });
  });

  it('takes the only number with no hint, and never picks among several', () => {
    expect(choosePhoneNumber([one], null)).toEqual({
      ok: true,
      phoneNumber: one,
    });
    expect(choosePhoneNumber([one, two], null)).toEqual({
      ok: false,
      reason: 'ambiguous',
    });
    expect(choosePhoneNumber([], null)).toEqual({
      ok: false,
      reason: 'unverified',
    });
  });
});

describe('signupPathFromHints', () => {
  it('labels a WhatsApp Business app number as coexistence, anything else as new', () => {
    expect(signupPathFromHints(hints({ isOnBusinessApp: true }))).toBe(
      'coexistence',
    );
    expect(signupPathFromHints(hints({ isOnBusinessApp: false }))).toBe(
      'new_number',
    );
    expect(signupPathFromHints(hints())).toBe('new_number');
  });
});
