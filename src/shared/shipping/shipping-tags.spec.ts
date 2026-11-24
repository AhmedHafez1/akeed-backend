import {
  findMatchingShippingTag,
  isAkeedTag,
  normalizeShippingTagSettings,
  shippingTagKey,
} from './shipping-tags';

/** A combining acute accent, written as a code point. */
const ACUTE = String.fromCharCode(0x0301);

describe('shipping tag matching', () => {
  it.each([
    [['شحن'], ['شحن'], 'شحن'],
    [[' شحن '], ['شحن'], 'شحن'],
    [['تم الشحن', 'VIP'], ['تم الشحن'], 'تم الشحن'],
    [['shipped'], ['Shipped'], 'Shipped'],
    [['SHIPPED'], ['Shipped'], 'Shipped'],
    [['ShIpPeD  '], ['shipped'], 'shipped'],
    [['Kargoya Verildi'], ['kargoya verildi'], 'kargoya verildi'],
    [['EXPÉDIÉ'], ['expédié'], 'expédié'],
    // A decomposed accent compares as the composed one.
    [[`expe${ACUTE}die${ACUTE}`], ['expédié'], 'expédié'],
    // Full-width Latin compares as its ordinary form.
    [['ＳＨＩＰＰＥＤ'], ['shipped'], 'shipped'],
  ])('order tags %j match saved %j', (orderTags, saved, expected) => {
    expect(findMatchingShippingTag(orderTags, saved)).toBe(expected);
  });

  it('returns the first saved tag present, in its saved spelling', () => {
    expect(
      findMatchingShippingTag(['b', 'shipped'], ['Out', 'Shipped', 'B']),
    ).toBe('Shipped');
  });

  it('does not match partial or different tags', () => {
    expect(findMatchingShippingTag(['shipped-later'], ['shipped'])).toBeNull();
    expect(findMatchingShippingTag(['شحنة'], ['شحن'])).toBeNull();
    expect(findMatchingShippingTag([], ['shipped'])).toBeNull();
    expect(findMatchingShippingTag(['shipped'], [])).toBeNull();
  });

  it('never matches an Akeed tag, whatever its case or spacing', () => {
    expect(
      findMatchingShippingTag(['Akeed: Verified'], ['Akeed: Verified']),
    ).toBeNull();
    expect(
      findMatchingShippingTag(
        ['  AKEED: Change Requested'],
        ['akeed: change requested'],
      ),
    ).toBeNull();
    expect(isAkeedTag('akeed:shipped')).toBe(true);
    expect(isAkeedTag('Akeedx: shipped')).toBe(false);
  });

  it('builds the comparison key from trim, NFKC and lower case', () => {
    expect(shippingTagKey('  Shipped ')).toBe('shipped');
    expect(shippingTagKey('شحن')).toBe('شحن');
  });
});

describe('normalizeShippingTagSettings', () => {
  it('trims and keeps the first spelling of tags that compare equal', () => {
    expect(
      normalizeShippingTagSettings([' Shipped', 'shipped ', 'SHIPPED', 'شحن']),
    ).toEqual({ ok: true, tags: ['Shipped', 'شحن'] });
  });

  it('applies the count limit after removing duplicates', () => {
    const tags = Array.from({ length: 10 }, (_, i) => `t${i}`);
    expect(normalizeShippingTagSettings([...tags, 'T0'])).toEqual({
      ok: true,
      tags,
    });
    expect(normalizeShippingTagSettings([...tags, 'extra'])).toEqual({
      ok: false,
      reason: 'too_many',
    });
  });

  it('counts characters, not UTF-16 units', () => {
    expect(normalizeShippingTagSettings(['ش'.repeat(40)]).ok).toBe(true);
    expect(normalizeShippingTagSettings(['📦'.repeat(40)]).ok).toBe(true);
    expect(normalizeShippingTagSettings(['ش'.repeat(41)])).toEqual({
      ok: false,
      reason: 'length',
    });
  });

  it('refuses empty and Akeed tags', () => {
    expect(normalizeShippingTagSettings([''])).toEqual({
      ok: false,
      reason: 'length',
    });
    expect(normalizeShippingTagSettings([' Akeed: Verified'])).toEqual({
      ok: false,
      reason: 'akeed_prefix',
    });
  });

  it('accepts an empty list', () => {
    expect(normalizeShippingTagSettings([])).toEqual({ ok: true, tags: [] });
  });
});
