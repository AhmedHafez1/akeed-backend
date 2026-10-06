import {
  currencyMinorUnits,
  formatOrderTotal,
  legacyOrderTotal,
} from './message-values';

describe('formatOrderTotal (US-08-07f)', () => {
  it.each([
    ['EGP', '1,250.00 ج.م', 'EGP 1,250.00'],
    ['SAR', '1,250.00 ر.س', 'SAR 1,250.00'],
    ['AED', '1,250.00 د.إ', 'AED 1,250.00'],
    ['USD', '1,250.00 $', 'USD 1,250.00'],
    ['QAR', '1,250.00 ر.ق', 'QAR 1,250.00'],
    ['KWD', '1,250.000 د.ك', 'KWD 1,250.000'],
    ['BHD', '1,250.000 د.ب', 'BHD 1,250.000'],
    ['OMR', '1,250.000 ر.ع', 'OMR 1,250.000'],
  ])('writes 1250.00 %s per language', (currency, arabic, english) => {
    expect(formatOrderTotal('1250.00', currency, 'ar')).toBe(arabic);
    expect(formatOrderTotal('1250.00', currency, 'en')).toBe(english);
  });

  it('writes an unknown currency with its ISO code, after in Arabic and before in English', () => {
    expect(formatOrderTotal('1250.00', 'XYZ', 'ar')).toBe('1,250.00 XYZ');
    expect(formatOrderTotal('1250.00', 'XYZ', 'en')).toBe('XYZ 1,250.00');
    expect(formatOrderTotal('99.5', 'JOD', 'ar')).toBe('99.500 JOD');
  });

  it('sends the number alone when the currency is missing', () => {
    for (const currency of [null, undefined, '', '  ']) {
      expect(formatOrderTotal('1250.00', currency, 'ar')).toBe('1,250.00');
      expect(formatOrderTotal('1250.00', currency, 'en')).toBe('1,250.00');
    }
  });

  it('always shows the minor units, and accepts a number or a lower-case code', () => {
    expect(formatOrderTotal('1250', 'egp', 'en')).toBe('EGP 1,250.00');
    expect(formatOrderTotal(1250.5, 'SAR', 'en')).toBe('SAR 1,250.50');
    expect(formatOrderTotal('0.5', 'USD', 'en')).toBe('USD 0.50');
    expect(formatOrderTotal('999', 'USD', 'en')).toBe('USD 999.00');
    expect(formatOrderTotal('1234567.89', 'EGP', 'en')).toBe(
      'EGP 1,234,567.89',
    );
  });

  it('never changes the amount: it drops only zeros past the minor units and never rounds', () => {
    expect(formatOrderTotal('1250.000', 'EGP', 'en')).toBe('EGP 1,250.00');
    expect(formatOrderTotal('1250.005', 'EGP', 'en')).toBe('EGP 1,250.005');
    expect(formatOrderTotal('1250.99', 'JPY', 'en')).toBe('JPY 1,250.99');
    expect(formatOrderTotal('1250.00', 'JPY', 'en')).toBe('JPY 1,250');
    const digitsOf = (value: string) => value.replace(/[^\d]/g, '');
    for (const amount of ['1250.00', '7.25', '100000.10', '0.01']) {
      for (const currency of ['EGP', 'SAR', 'USD']) {
        expect(
          Number(
            formatOrderTotal(amount, currency, 'en')
              .replace(currency, '')
              .replace(/,/g, ''),
          ),
        ).toBe(Number(amount));
        expect(digitsOf(formatOrderTotal(amount, currency, 'ar'))).toBe(
          digitsOf(formatOrderTotal(amount, currency, 'en')),
        );
      }
    }
  });

  it('sends a value that is not a plain decimal as it always was', () => {
    expect(formatOrderTotal(null, 'EGP', 'ar')).toBe(
      legacyOrderTotal(null, 'EGP'),
    );
    expect(formatOrderTotal('-5.00', 'EGP', 'en')).toBe('-5.00 EGP');
    expect(formatOrderTotal('1e3', 'EGP', 'en')).toBe('1e3 EGP');
    expect(formatOrderTotal('1250.00', 'Egyptian pound', 'en')).toBe(
      '1250.00 Egyptian pound',
    );
  });

  it('uses Western digits in Arabic', () => {
    expect(formatOrderTotal('1250.00', 'EGP', 'ar')).not.toMatch(/[٠-٩]/);
  });

  it('reads minor units from the ISO code', () => {
    expect(currencyMinorUnits('KWD')).toBe(3);
    expect(currencyMinorUnits('EGP')).toBe(2);
    expect(currencyMinorUnits('not a code')).toBe(2);
  });
});

describe('legacyOrderTotal', () => {
  it('is the number, a space and the code, exactly as before', () => {
    expect(legacyOrderTotal('1250.00', 'EGP')).toBe('1250.00 EGP');
    expect(legacyOrderTotal('1250.00', null)).toBe('1250.00');
  });
});
