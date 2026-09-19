import { foldArabicText, headerKey, headerSignature } from './header-key';

const FATHA = String.fromCharCode(0x064e);
const SHADDA = String.fromCharCode(0x0651);
const SUKUN = String.fromCharCode(0x0652);
const TATWEEL = String.fromCharCode(0x0640);
const ZERO_WIDTH_JOINER = String.fromCharCode(0x200d);
const RIGHT_TO_LEFT_MARK = String.fromCharCode(0x200f);
const NO_BREAK_SPACE = String.fromCharCode(0x00a0);
const arabicIndic = (digits: string) =>
  [...digits].map((d) => String.fromCharCode(0x0660 + Number(d))).join('');
const persian = (digits: string) =>
  [...digits].map((d) => String.fromCharCode(0x06f0 + Number(d))).join('');

describe('headerKey (US-04.6-03 AC1)', () => {
  it.each([
    ['lowercases', 'PHONE', 'phone'],
    ['removes whitespace', ' Phone   Number ', 'phonenumber'],
    ['removes a no-break space', `Phone${NO_BREAK_SPACE}Number`, 'phonenumber'],
    ['removes punctuation', 'Order-#', 'order'],
    ['removes symbols', 'Total ($)', 'total'],
    ['removes underscores', 'customer_name', 'customername'],
    [
      'removes format characters',
      `Pho${ZERO_WIDTH_JOINER}ne${RIGHT_TO_LEFT_MARK}`,
      'phone',
    ],
    ['strips diacritics', `ال${FATHA}م${SHADDA}دين${SUKUN}ه`, 'المدينه'],
    ['strips tatweel', `الـ${TATWEEL}ـعنوان`, 'العنوان'],
    ['folds alef with hamza above', 'أسم', 'اسم'],
    ['folds alef with hamza below', 'إسم', 'اسم'],
    ['folds alef with madda', 'آسم', 'اسم'],
    ['folds taa marbuta', 'المدينة', 'المدينه'],
    ['folds alef maksura', 'مستوى', 'مستوي'],
    ['converts Arabic-Indic digits', `عنوان ${arabicIndic('12')}`, 'عنوان12'],
    ['converts Persian digits', `عنوان ${persian('34')}`, 'عنوان34'],
    ['removes Arabic punctuation', 'الاسم، الأول؟', 'الاسمالاول'],
    ['keeps an empty key for a punctuation-only header', '#', ''],
  ])('%s', (_label, header, key) => {
    expect(headerKey(header)).toBe(key);
  });

  it('keeps words apart in the folded text form', () => {
    expect(foldArabicText('الدفع عند الإستلام')).toBe('الدفع عند الاستلام');
  });
});

describe('headerSignature', () => {
  it('ignores column order and spelling variants', () => {
    expect(headerSignature(['Phone', 'الاسم', 'Total'])).toBe(
      headerSignature(['TOTAL', 'phone', 'الإسم']),
    );
  });

  it('changes when a header changes', () => {
    expect(headerSignature(['Phone', 'Name'])).not.toBe(
      headerSignature(['Phone', 'Customer']),
    );
  });

  it('is a SHA-256 hex digest', () => {
    expect(headerSignature(['a'])).toMatch(/^[0-9a-f]{64}$/);
  });
});
