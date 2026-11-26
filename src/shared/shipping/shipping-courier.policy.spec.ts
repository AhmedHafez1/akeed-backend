import {
  recognizeShippingCourier,
  resolveShippingTrackingLink,
} from './shipping-courier.policy';
import {
  generateShippingTrackingCode,
  isWellFormedShippingTrackingCode,
} from './shipping-tracking-code';

describe('recognizeShippingCourier', () => {
  it.each(['Bosta', ' bosta ', 'BOSTA', 'بوسطة'])('knows %s', (name) => {
    expect(recognizeShippingCourier(name)?.name).toBe('Bosta');
  });

  it.each(['Yurtiçi Kargo', 'yurtici', 'YURTICI KARGO'])(
    'knows Yurtiçi as %s',
    (name) => {
      expect(recognizeShippingCourier(name)?.name).toBe('Yurtiçi Kargo');
    },
  );

  it('matches DHL Express without spaces or case', () => {
    expect(recognizeShippingCourier('dhl express')?.name).toBe('DHL Express');
  });

  it.each([null, undefined, '', 'Unknown Courier', 'Mylerz'])(
    'does not know %s',
    (name) => {
      expect(recognizeShippingCourier(name)).toBeNull();
    },
  );
});

describe('resolveShippingTrackingLink', () => {
  it('prefers the link the store sent', () => {
    expect(
      resolveShippingTrackingLink({
        url: 'https://carrier.example/t/1',
        company: 'Bosta',
        number: '123',
      }),
    ).toEqual({
      kind: 'carrier_link',
      url: 'https://carrier.example/t/1',
      courier: 'Bosta',
    });
  });

  it('builds a known courier page from the number', () => {
    expect(
      resolveShippingTrackingLink({ company: 'aramex', number: '4455 66' }),
    ).toEqual({
      kind: 'courier_page',
      url: 'https://www.aramex.com/us/en/track/results?ShipmentNumber=4455%2066',
      courier: 'Aramex',
    });
  });

  it.each(['http://carrier.example/1', 'javascript:alert(1)', 'not a url'])(
    'never redirects to %s',
    (url) => {
      expect(
        resolveShippingTrackingLink({ url, number: 'N1', company: 'Acme' }),
      ).toEqual({ kind: 'number_only', courier: 'Acme' });
    },
  );

  it('shows the number for an unknown courier', () => {
    expect(
      resolveShippingTrackingLink({ company: 'Mylerz', number: 'M1' }),
    ).toEqual({ kind: 'number_only', courier: 'Mylerz' });
  });

  it('has nothing to show without a number or link', () => {
    expect(resolveShippingTrackingLink({ company: 'Bosta' })).toEqual({
      kind: 'none',
      courier: 'Bosta',
    });
    expect(resolveShippingTrackingLink({})).toEqual({
      kind: 'none',
      courier: null,
    });
  });
});

describe('shipping tracking code', () => {
  it('is random, URL-safe and at least 128 bits', () => {
    const codes = new Set(
      Array.from({ length: 200 }, () => generateShippingTrackingCode()),
    );
    expect(codes.size).toBe(200);
    for (const code of codes) {
      expect(code).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(isWellFormedShippingTrackingCode(code)).toBe(true);
    }
  });

  it.each(['', 'short', 'a'.repeat(44), 'has space in it ok!!!!!', 3, null])(
    'refuses the malformed code %p',
    (value) => {
      expect(isWellFormedShippingTrackingCode(value)).toBe(false);
    },
  );
});
