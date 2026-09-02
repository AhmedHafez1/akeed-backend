import {
  isPlatformType,
  SUPPORTED_PLATFORM_TYPES,
} from './commerce-source.interface';

describe('canonical commerce source contract', () => {
  it('exposes every supported platform exactly once', () => {
    expect(SUPPORTED_PLATFORM_TYPES).toEqual([
      'shopify',
      'salla',
      'zid',
      'woocommerce',
      'standalone',
      'easyorders',
    ]);
    expect(new Set(SUPPORTED_PLATFORM_TYPES).size).toBe(
      SUPPORTED_PLATFORM_TYPES.length,
    );
  });

  it.each(SUPPORTED_PLATFORM_TYPES)(
    'accepts canonical platform %s',
    (value) => {
      expect(isPlatformType(value)).toBe(true);
    },
  );

  it.each(['', 'magento', 'SHOPIFY', ' shopify ', null, undefined, 1])(
    'rejects unsupported platform %p',
    (value) => {
      expect(isPlatformType(value)).toBe(false);
    },
  );
});
