import {
  canonicalizeWooCommerceStoreUrl,
  wooCommerceStoreHost,
} from './woocommerce-store-url';

describe('canonicalizeWooCommerceStoreUrl', () => {
  it.each([
    ['https://example.com', 'https://example.com'],
    ['https://example.com/', 'https://example.com'],
    ['  https://example.com///  ', 'https://example.com'],
    ['HTTPS://Shop.Example.COM', 'https://shop.example.com'],
    ['https://example.com:443', 'https://example.com'],
    ['https://example.com:443/shop/', 'https://example.com/shop'],
    // A store in a subdirectory keeps its path, in the case it was typed.
    ['https://example.com/shop', 'https://example.com/shop'],
    ['https://example.com/Stores/eg/', 'https://example.com/Stores/eg'],
    ['https://example.com/my.shop-1_a~b', 'https://example.com/my.shop-1_a~b'],
    // Two different stores, on purpose.
    ['https://www.example.com', 'https://www.example.com'],
    ['https://xn--wgbh1c.example.com', 'https://xn--wgbh1c.example.com'],
    ['https://sub.shop.co.uk/a/b/c', 'https://sub.shop.co.uk/a/b/c'],
  ])('accepts %s as %s', (input, canonical) => {
    expect(canonicalizeWooCommerceStoreUrl(input)).toEqual({
      ok: true,
      url: canonical,
    });
  });

  it('stores an internationalized host in its ASCII form', () => {
    const typed = `https://${String.fromCharCode(0x645, 0x62a, 0x62c, 0x631)}.example.com`;
    const result = canonicalizeWooCommerceStoreUrl(typed);

    expect(result.ok && result.url).toMatch(
      /^https:\/\/xn--[a-z0-9-]+\.example\.com$/,
    );
  });

  it.each(['http://example.com', 'HTTP://example.com/shop'])(
    'refuses plain HTTP with its own reason: %s',
    (input) => {
      expect(canonicalizeWooCommerceStoreUrl(input)).toEqual({
        ok: false,
        reason: 'https_required',
      });
    },
  );

  it.each([
    ['no scheme', 'example.com'],
    ['a scheme-relative address', '//example.com'],
    ['another scheme', 'ftp://example.com'],
    ['a script', 'javascript://example.com/%0aalert(1)'],
    ['empty', ''],
    ['only spaces', '   '],
    ['not a string', 42],
    ['nothing', undefined],
    ['a user', 'https://admin@example.com'],
    ['a user and password', 'https://admin:pw@example.com'],
    ['an empty user', 'https://@example.com'],
    ['a query', 'https://example.com/?a=1'],
    ['an empty query', 'https://example.com/?'],
    ['a fragment', 'https://example.com/#top'],
    ['another port', 'https://example.com:8443'],
    ['port 80', 'https://example.com:80'],
    ['an IPv4 literal', 'https://93.184.216.34'],
    ['a private IPv4 literal', 'https://10.0.0.1'],
    ['a decimal IPv4 literal', 'https://2130706433'],
    ['a hex IPv4 literal', 'https://0x7f.0.0.1'],
    ['an IPv6 literal', 'https://[2606:4700::1111]'],
    ['IPv6 loopback', 'https://[::1]'],
    ['localhost', 'https://localhost'],
    ['a name with no dot', 'https://intranet'],
    ['a trailing dot', 'https://example.com.'],
    ['an empty label', 'https://example..com'],
    ['a label starting with a hyphen', 'https://-bad.example.com'],
    ['an underscore in the host', 'https://my_shop.example.com'],
    ['a space', 'https://example.com/my shop'],
    ['a line break', `https://example.com/${String.fromCharCode(10)}x`],
    ['a tab in the host', `https://exa${String.fromCharCode(9)}mple.com`],
    ['an empty path segment', 'https://example.com/a//b'],
    ['a dot segment', 'https://example.com/a/./b'],
    ['a parent segment', 'https://example.com/a/../b'],
    ['a trailing parent segment', 'https://example.com/shop/..'],
    ['a percent sign', 'https://example.com/a%2fb'],
    ['an encoded dot segment', 'https://example.com/%2e%2e/x'],
    ['a backslash', 'https://example.com\\shop'],
    ['a backslash before the host', 'https://evil.example\\@example.com'],
    ['the REST path', 'https://example.com/wp-json'],
    ['the REST path deeper', 'https://example.com/shop/wp-json/wc/v3'],
    ['the REST path in other case', 'https://example.com/WP-JSON'],
    ['the authorize path', 'https://example.com/wc-auth/v1/authorize'],
    ['a non-ASCII path', `https://example.com/${String.fromCharCode(0x645)}`],
    ['more than 255 characters', `https://example.com/${'a'.repeat(240)}`],
  ])('refuses %s', (_label, input) => {
    expect(canonicalizeWooCommerceStoreUrl(input)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('accepts exactly 255 characters', () => {
    const url = `https://example.com/${'a'.repeat(235)}`;

    expect(url).toHaveLength(255);
    expect(canonicalizeWooCommerceStoreUrl(url)).toEqual({ ok: true, url });
  });

  it('is stable: a canonical URL canonicalizes to itself', () => {
    for (const url of ['https://example.com', 'https://example.com/a/b']) {
      expect(canonicalizeWooCommerceStoreUrl(url)).toEqual({ ok: true, url });
    }
  });
});

describe('wooCommerceStoreHost', () => {
  it('gives the host and nothing of the path', () => {
    expect(wooCommerceStoreHost('https://example.com/private/shop')).toBe(
      'example.com',
    );
  });
});
