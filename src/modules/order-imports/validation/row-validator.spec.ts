import { StandaloneOrderEligibilityStrategy } from '../../../infrastructure/spokes/standalone/services/standalone-order-eligibility.strategy';
import { PhoneService } from '../../../shared/services/phone.service';
import { OrderEligibilityService } from '../../verification-core/order-eligibility.service';
import type {
  ImportColumnMapping,
  ImportOptions,
} from '../mapping/mapping-rules';
import { validateAmount } from './amount';
import { resolveCurrency } from './currency';
import { validateOrderDate, type OrderDateContext } from './date';
import { validateName } from './name';
import { validatePhone } from './phone';
import { validateOrderReference } from './reference';
import {
  validateRow,
  type RowValidationContext,
  type RowValidatorDeps,
} from './row-validator';
import { cleanCell } from './text';

/* Arabic and invisible characters are built from code points on purpose. */
const ar = (...codes: number[]) => String.fromCharCode(...codes);
const arabicIndic = (digits: string) =>
  [...digits]
    .map((d) => (d === '.' ? ar(0x066b) : ar(0x0660 + Number(d))))
    .join('');
const persian = (digits: string) =>
  [...digits].map((d) => ar(0x06f0 + Number(d))).join('');
const EGP_SHORT = ar(0x062c, 0x002e, 0x0645); // ج.م
const EGP_WORD = ar(0x062c, 0x0646, 0x064a, 0x0647); // جنيه
const SAR_SHORT = ar(0x0631, 0x002e, 0x0633); // ر.س
const AED_SHORT = ar(0x062f, 0x002e, 0x0625); // د.إ
const ARABIC_SEMICOLON = ar(0x061b);
const ZERO_WIDTH_SPACE = ar(0x200b);
const LEFT_TO_RIGHT_EMBEDDING = ar(0x202a);
const POP_DIRECTIONAL = ar(0x202c);
const CASH_AR = ar(0x0643, 0x0627, 0x0634); // كاش
const ON_DELIVERY_AR = ar(
  0x0639,
  0x0646,
  0x062f,
  0x0020,
  0x0627,
  0x0644,
  0x0627,
  0x0633,
  0x062a,
  0x0644,
  0x0627,
  0x0645,
); // عند الاستلام
const PAID_AR = ar(0x0645, 0x062f, 0x0641, 0x0648, 0x0639); // مدفوع
const AHMED_AR = ar(0x0623, 0x062d, 0x0645, 0x062f); // أحمد

const phones = new PhoneService();
const eligibility = new OrderEligibilityService([
  new StandaloneOrderEligibilityStrategy(),
]);
const deps: RowValidatorDeps = {
  standardizeMobile: (phone, country) =>
    phones.standardizeMobile(phone, country),
  evaluateEligibility: (params) =>
    eligibility.evaluateOrderForVerification(params),
};
const mobile = deps.standardizeMobile;

/** 13:00 in Cairo (UTC+3 in September): "today" is 2026-09-19. */
const NOW = new Date('2026-09-19T10:00:00Z');

const mapping: ImportColumnMapping = {
  phone: 'phone',
  customerName: ['first', 'last'],
  amount: 'total',
  orderReference: 'ref',
  currency: 'currency',
  paymentMethod: 'payment',
  orderDate: 'date',
  city: 'city',
  address: 'address',
  notes: 'notes',
};
const options: ImportOptions = {
  country: 'EG',
  defaultCurrency: 'EGP',
  dateFormat: 'auto',
  paymentValueMap: {},
};

function context(
  overrides: Partial<RowValidationContext> = {},
): RowValidationContext {
  return {
    orgId: 'org-1',
    integrationId: 'int-1',
    integration: {
      platformType: 'standalone',
      assumeCodWhenPaymentMissing: false,
    },
    mapping,
    options,
    detectedDateFormat: null,
    timezone: 'Africa/Cairo',
    now: NOW,
    maxOrderAgeDays: 7,
    ...overrides,
  };
}

const goodRow = {
  phone: '01012345678',
  first: 'Ahmed',
  last: '',
  total: '750',
  ref: '#1001',
  currency: '',
  payment: 'COD',
  date: '2026-09-18',
};

describe('cell text (AC1)', () => {
  it.each([
    ['Arabic-Indic digits', arabicIndic('0123456789'), '0123456789'],
    ['Persian digits', persian('0123456789'), '0123456789'],
    ['the Arabic decimal separator', arabicIndic('750.50'), '750.50'],
    ['the Arabic thousands separator', `1${ar(0x066c)}250`, '1250'],
    ['a zero-width space', `010${ZERO_WIDTH_SPACE}12345678`, '01012345678'],
    [
      'bidi embedding marks',
      `${LEFT_TO_RIGHT_EMBEDDING}+201012345678${POP_DIRECTIONAL}`,
      '+201012345678',
    ],
    ['collapsed whitespace', '  Ahmed \t  Ali  ', 'Ahmed Ali'],
    ['NFD to NFC', ar(0x65, 0x301), ar(0xe9)],
  ])('normalizes %s', (_case, input, expected) => {
    expect(cleanCell(input)).toBe(expected);
  });
});

describe('phone (AC2, epic Data catalogue)', () => {
  const E164 = '+201012345678';
  it.each([
    ['+201012345678', E164],
    ['00201012345678', E164],
    ['201012345678', E164],
    ['01012345678', E164],
    ['1012345678 (Excel dropped the zero)', E164],
    ['010-1234-5678', E164],
    ['010 1234 5678', E164],
    ['(010) 1234.5678', E164],
    [arabicIndic('01012345678'), E164],
    ['+966501234567 (Saudi number in an Egypt import)', '+966501234567'],
  ])('accepts %s', (input, expected) => {
    const cell = cleanCell(input.replace(/ \(.*\)$/, ''));
    expect(validatePhone(cell, 'EG', mobile)).toEqual({
      ok: true,
      value: expected,
    });
  });

  it.each([
    ['', 'PHONE_MISSING'],
    ['2.01012E+11', 'PHONE_SCIENTIFIC_NOTATION'],
    ['01012345678 / 01112345678', 'PHONE_MULTIPLE'],
    ['01012345678, 01112345678', 'PHONE_MULTIPLE'],
    [`01012345678${ARABIC_SEMICOLON}01112345678`, 'PHONE_MULTIPLE'],
    ['01012345678 or 01112345678', 'PHONE_MULTIPLE'],
    ['0223456789', 'PHONE_NOT_MOBILE'],
    ['010123', 'PHONE_INVALID'],
    ['0101234567890123', 'PHONE_INVALID'],
    ['not a phone', 'PHONE_INVALID'],
  ])('refuses %j with %s', (input, code) => {
    expect(validatePhone(cleanCell(input), 'EG', mobile)).toEqual({
      ok: false,
      issue: { code, field: 'phone' },
    });
  });

  it('reads a leading-zero-less number only as Egyptian in an Egypt import', () => {
    expect(validatePhone('1012345678', 'SA', mobile)).toEqual({
      ok: false,
      issue: { code: 'PHONE_INVALID', field: 'phone' },
    });
  });
});

describe('name (AC3)', () => {
  it.each([
    [[''], 'NAME_MISSING'],
    [[cleanCell('   ')], 'NAME_MISSING'],
    [['12345'], 'NAME_NOT_TEXT'],
    [['\u{1F600}\u{1F389}'], 'NAME_NOT_TEXT'],
    [['a'.repeat(256)], 'NAME_TOO_LONG'],
  ])('refuses %j with %s', (parts, code) => {
    expect(validateName(parts)).toEqual({
      ok: false,
      issue: { code, field: 'customerName' },
    });
  });

  it.each([
    [['Ahmed', 'Ali'], 'Ahmed Ali'],
    [['Ahmed', ''], 'Ahmed'],
    [[AHMED_AR], AHMED_AR],
    [['a'.repeat(255)], 'a'.repeat(255)],
    [['Ahmed 2'], 'Ahmed 2'],
  ])('accepts %j as %j', (parts, expected) => {
    expect(validateName(parts)).toEqual({ ok: true, value: expected });
  });
});

describe('amount (AC4, epic Data catalogue)', () => {
  it.each([
    ['750', '750.00', null],
    ['750.5', '750.50', null],
    ['1,250.00', '1250.00', null],
    ['1.250,00', '1250.00', null],
    ['1,250', '1250.00', null],
    ['1,250,000', '1250000.00', null],
    ['750,5', '750.50', null],
    ['1,25', '1.25', null],
    ['EGP 750', '750.00', 'EGP'],
    [`750 ${EGP_SHORT}`, '750.00', 'EGP'],
    [`750 ${EGP_WORD}`, '750.00', 'EGP'],
    ['L.E 99', '99.00', 'EGP'],
    ['99 LE', '99.00', 'EGP'],
    [`120 ${SAR_SHORT}`, '120.00', 'SAR'],
    [`120 ${AED_SHORT}`, '120.00', 'AED'],
    ['$ 1,250.5', '1250.50', 'USD'],
    ['USD 10', '10.00', 'USD'],
    [arabicIndic('750.50'), '750.50', null],
    ['100000000', '100000000.00', null],
    ['9999999999.99', '9999999999.99', null],
    ['0750', '750.00', null],
    ['1 250', '1250.00', null],
  ])('reads %j as %s', (input, totalPrice, currency) => {
    expect(validateAmount(cleanCell(input))).toEqual({
      ok: true,
      value: { totalPrice, currency },
    });
  });

  it.each([
    ['', 'AMOUNT_MISSING'],
    ['0', 'AMOUNT_NOT_POSITIVE'],
    ['0.00', 'AMOUNT_NOT_POSITIVE'],
    ['-50', 'AMOUNT_NOT_POSITIVE'],
    ['750.555', 'AMOUNT_TOO_PRECISE'],
    ['12345678901', 'AMOUNT_TOO_LARGE'],
    ['1,2345', 'AMOUNT_AMBIGUOUS'],
    ['1,250,5', 'AMOUNT_AMBIGUOUS'],
    ['abc', 'AMOUNT_INVALID'],
    ['EGP', 'AMOUNT_INVALID'],
    ['1.2.3', 'AMOUNT_INVALID'],
    ['7five0', 'AMOUNT_INVALID'],
  ])('refuses %j with %s', (input, code) => {
    expect(validateAmount(cleanCell(input))).toEqual({
      ok: false,
      issue: { code, field: 'amount' },
    });
  });
});

describe('currency (AC5)', () => {
  it.each([
    ['egp', null, 'EGP'],
    [' sar ', null, 'SAR'],
    [EGP_WORD, null, 'EGP'],
    [EGP_SHORT, null, 'EGP'],
    ['LE', null, 'EGP'],
    ['$', null, 'USD'],
    ['', 'SAR', 'SAR'],
    ['', null, 'EGP'],
    ['AED', 'SAR', 'AED'],
  ])('resolves %j (amount currency %j) to %s', (cell, fromAmount, expected) => {
    expect(resolveCurrency(cleanCell(cell), fromAmount, 'EGP')).toEqual({
      ok: true,
      value: expected,
    });
  });

  it('refuses a currency outside the canonical list', () => {
    expect(resolveCurrency('XYZ', null, 'EGP')).toEqual({
      ok: false,
      issue: { code: 'CURRENCY_UNSUPPORTED', field: 'currency' },
    });
  });
});

describe('order date (AC7, epic Data catalogue)', () => {
  const dateContext = (
    overrides: Partial<OrderDateContext> = {},
  ): OrderDateContext => ({
    dateFormat: 'auto',
    detectedFormat: null,
    timezone: 'Africa/Cairo',
    now: NOW,
    maxOrderAgeDays: 7,
    ...overrides,
  });

  it.each([
    ['2026-09-18', {}, '2026-09-18'],
    ['18/09/2026', {}, '2026-09-18'],
    ['09/18/2026', {}, '2026-09-18'],
    ['18-9-26', {}, '2026-09-18'],
    ['2026/09/18', {}, '2026-09-18'],
    ['46283 (Excel serial)', {}, '2026-09-18'],
    ['2026-09-18T23:30:00Z (next day in Cairo)', {}, '2026-09-19'],
    ['2026-09-18T23:30:00+03:00', {}, '2026-09-18'],
    ['2026-09-18 10:15', {}, '2026-09-18'],
    [
      '05/09/2026',
      { dateFormat: 'DMY' as const, maxOrderAgeDays: 90 },
      '2026-09-05',
    ],
    ['09/15/2026', { dateFormat: 'MDY' as const }, '2026-09-15'],
    [
      '05/09/2026',
      { detectedFormat: 'MDY' as const, maxOrderAgeDays: 365 },
      '2026-05-09',
    ],
    ['26/09/18', { dateFormat: 'YMD' as const }, '2026-09-18'],
    ['2026-09-20 (one day ahead)', {}, '2026-09-20'],
    ['2026-09-12 (seven days old)', {}, '2026-09-12'],
  ])('reads %j as %s', (input, overrides, expected) => {
    expect(
      validateOrderDate(input.replace(/ \(.*\)$/, ''), dateContext(overrides)),
    ).toEqual({ value: expected });
  });

  it.each([
    ['yesterday', 'ORDER_DATE_INVALID'],
    ['31/02/2026', 'ORDER_DATE_INVALID'],
    ['2026-13-01', 'ORDER_DATE_INVALID'],
    ['2026-09-21', 'ORDER_DATE_FUTURE'],
    ['2026-09-11', 'ORDER_TOO_OLD'],
  ])('flags %j with %s', (input, code) => {
    expect(validateOrderDate(input, dateContext()).issue).toMatchObject({
      code,
      field: 'orderDate',
    });
  });

  it('leaves a blank date alone', () => {
    expect(validateOrderDate('', dateContext())).toEqual({});
  });

  it('honors the configured age window', () => {
    expect(
      validateOrderDate('2026-09-11', dateContext({ maxOrderAgeDays: 14 })),
    ).toEqual({ value: '2026-09-11' });
  });
});

describe('order reference (AC8)', () => {
  it.each([
    ['#1001', 'ref:1001'],
    ['# 10 01', 'ref:1001'],
    ['ORD-7', 'ref:ord-7'],
  ])('keys %j as %s', (input, key) => {
    expect(validateOrderReference(input)).toEqual({
      orderNumber: input,
      dedupeKey: key,
    });
  });

  it('refuses a reference over the manual order-number limit', () => {
    expect(validateOrderReference('x'.repeat(101))).toEqual({
      dedupeKey: null,
      issue: { code: 'ORDER_REF_TOO_LONG', field: 'orderReference' },
    });
  });

  it('leaves identity to commit without a reference', () => {
    expect(validateOrderReference('')).toEqual({ dedupeKey: null });
  });
});

describe('validateRow', () => {
  const run = (
    raw: Record<string, string>,
    overrides: Partial<RowValidationContext> = {},
    storedIssues: unknown = [],
  ) => validateRow(raw, storedIssues, context(overrides), deps);

  it('normalizes a complete row into the bulk envelope order fields', () => {
    expect(
      run({
        ...goodRow,
        first: 'Ahmed',
        last: 'Ali',
        city: 'Cairo',
        address: '1 Nile St',
        notes: 'Ring twice',
      }),
    ).toEqual({
      normalized: {
        orderNumber: '#1001',
        customerPhone: '+201012345678',
        customerName: 'Ahmed Ali',
        totalPrice: '750.00',
        currency: 'EGP',
        paymentMethod: 'cash on delivery',
        paymentMethodOriginal: 'COD',
        orderDate: '2026-09-18',
        city: 'Cairo',
        address: '1 Nile St',
        notes: 'Ring twice',
      },
      issues: [],
      outcome: 'ready',
      dedupeKey: 'ref:1001',
    });
  });

  describe('payment (AC6) through the shared eligibility decision', () => {
    it.each([
      ['COD', 'cash on delivery'],
      ['Cash', 'cash on delivery'],
      [CASH_AR, 'cash on delivery'],
      [ON_DELIVERY_AR, 'cash on delivery'],
    ])('makes %j ready as %j', (payment, paymentMethod) => {
      const row = run({ ...goodRow, payment });
      expect(row.outcome).toBe('ready');
      expect(row.normalized).toMatchObject({
        paymentMethod,
        paymentMethodOriginal: payment,
      });
    });

    it.each(['Paid', 'Visa', PAID_AR, 'InstaPay'])(
      'excludes %j as PAYMENT_NOT_COD, keeping its text',
      (payment) => {
        const row = run({ ...goodRow, payment });
        expect(row.outcome).toBe('excluded');
        expect(row.issues).toEqual([
          { code: 'PAYMENT_NOT_COD', field: 'paymentMethod' },
        ]);
        expect(row.normalized.paymentMethodOriginal).toBeUndefined();
      },
    );

    it('excludes a blank payment unless the store assumes COD', () => {
      const excluded = run({ ...goodRow, payment: '' });
      expect(excluded.outcome).toBe('excluded');
      expect(excluded.issues).toEqual([
        { code: 'PAYMENT_UNKNOWN_EXCLUDED', field: 'paymentMethod' },
      ]);
      expect(excluded.normalized.paymentMethod).toBe('');

      const assumed = run(
        { ...goodRow, payment: '' },
        {
          integration: {
            platformType: 'standalone',
            assumeCodWhenPaymentMissing: true,
          },
        },
      );
      expect(assumed.outcome).toBe('ready');
    });

    it("follows the merchant's classification over the automatic one", () => {
      const notCod = run(
        { ...goodRow, payment: 'COD' },
        { options: { ...options, paymentValueMap: { cod: 'not_cod' } } },
      );
      expect(notCod.issues).toEqual([
        { code: 'PAYMENT_NOT_COD', field: 'paymentMethod' },
      ]);

      const cod = run(
        { ...goodRow, payment: 'Online' },
        { options: { ...options, paymentValueMap: { online: 'cod' } } },
      );
      expect(cod.outcome).toBe('ready');
      expect(cod.normalized).toMatchObject({
        paymentMethod: 'cash on delivery',
        paymentMethodOriginal: 'Online',
      });
    });

    it('allows mixed payment values across rows', () => {
      expect(
        ['COD', 'Paid', 'COD'].map(
          (payment) => run({ ...goodRow, payment }).outcome,
        ),
      ).toEqual(['ready', 'excluded', 'ready']);
    });
  });

  it('records every issue and applies invalid > excluded', () => {
    const row = run({
      ...goodRow,
      phone: '0223456789',
      total: '0',
      payment: 'Paid',
      date: '2026-09-01',
    });
    expect(row.issues.map((issue) => issue.code)).toEqual([
      'PHONE_NOT_MOBILE',
      'AMOUNT_NOT_POSITIVE',
      'ORDER_TOO_OLD',
      'PAYMENT_NOT_COD',
    ]);
    expect(row.outcome).toBe('invalid');
  });

  it('allows mixed currencies across rows', () => {
    expect(run({ ...goodRow, currency: 'sar' }).normalized.currency).toBe(
      'SAR',
    );
    expect(run({ ...goodRow, currency: '' }).normalized.currency).toBe('EGP');
  });

  it('keeps parser issues: a truncated mapped cell is invalid, an unmapped one is not', () => {
    const mapped = run(goodRow, {}, [
      { code: 'FIELD_TOO_LONG', field: 'notes' },
    ]);
    expect(mapped.outcome).toBe('invalid');

    const unmapped = run(goodRow, {}, [
      { code: 'FIELD_TOO_LONG', field: 'Line item properties' },
      { code: 'POSSIBLE_DUPLICATE' }, // A previous run's issue is dropped.
    ]);
    expect(unmapped.outcome).toBe('ready');
    expect(unmapped.issues).toEqual([
      {
        code: 'FIELD_TOO_LONG',
        field: 'Line item properties',
        informational: true,
      },
    ]);

    expect(run(goodRow, {}, [{ code: 'CSV_MALFORMED_QUOTE' }]).outcome).toBe(
      'invalid',
    );
  });

  it('re-normalizes from raw when the import country changes', () => {
    const raw = { ...goodRow, phone: '501234567' };
    // An Egyptian landline under EG; a Saudi mobile under SA.
    expect(run(raw).issues).toEqual([
      { code: 'PHONE_NOT_MOBILE', field: 'phone' },
    ]);
    const saudi = run(raw, { options: { ...options, country: 'SA' } });
    expect(saudi.outcome).toBe('ready');
    expect(saudi.normalized.customerPhone).toBe('+966501234567');
  });

  it('is deterministic', () => {
    expect(run(goodRow)).toEqual(run(goodRow));
  });
});
