import { resolveCustomerActionPayload } from '../messaging/change-request-messaging';
import {
  isShippingPayload,
  resolveShippingPayload,
  shippingButtonPayload,
  shippingButtonPayloads,
} from './shipping-reply';

const ID = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';

describe('shipping quick-reply payloads', () => {
  it('builds sh1|<reply>|<verificationId> in button order', () => {
    expect(shippingButtonPayloads(ID)).toEqual([
      `sh1|home|${ID}`,
      `sh1|reschedule|${ID}`,
      `sh1|address|${ID}`,
    ]);
  });

  it.each(['home', 'reschedule', 'address'] as const)(
    'round-trips %s',
    (reply) => {
      expect(resolveShippingPayload(shippingButtonPayload(reply, ID))).toEqual({
        reply,
        verificationId: ID,
      });
    },
  );

  it('reads an upper-case id as the same verification', () => {
    expect(resolveShippingPayload(`sh1|home|${ID.toUpperCase()}`)).toEqual({
      reply: 'home',
      verificationId: ID,
    });
  });

  it.each([
    ['an unknown reply', `sh1|cancel|${ID}`],
    ['an extra part', `sh1|home|${ID}|1`],
    ['a missing id', 'sh1|home|'],
    ['a malformed id', 'sh1|home|not-a-uuid'],
    ['another version', `sh2|home|${ID}`],
    ['a confirmation payload', `cr1|confirmed|${ID}|1`],
    ['nothing', ''],
  ])('refuses %s', (_label, payload) => {
    expect(resolveShippingPayload(payload)).toBeNull();
  });

  it('refuses no payload at all', () => {
    expect(resolveShippingPayload(undefined)).toBeNull();
    expect(resolveShippingPayload(null)).toBeNull();
  });

  it('marks any sh1 payload, valid or not, as a shipping reply', () => {
    expect(isShippingPayload(`sh1|home|${ID}`)).toBe(true);
    expect(isShippingPayload('sh1|garbage')).toBe(true);
    expect(isShippingPayload(`cr1|confirmed|${ID}|1`)).toBe(false);
    expect(isShippingPayload(undefined)).toBe(false);
  });

  it('is never read as a confirmation answer, and cr1 is untouched', () => {
    expect(resolveCustomerActionPayload(`sh1|home|${ID}`)).toBeNull();
    expect(resolveCustomerActionPayload(`cr1|confirmed|${ID}|2`)).toEqual({
      intent: 'confirmed',
      verificationId: ID,
      cycle: 2,
    });
    expect(resolveCustomerActionPayload(`confirm_${ID}`)).toMatchObject({
      intent: 'confirmed',
      verificationId: ID,
    });
  });
});
