import {
  AMBIGUOUS_NAME_KEY,
  FIELD_ALIAS_KEYS,
  IMPORT_FIELDS,
  MAPPING_DICTIONARY_VERSION,
  type ImportField,
} from './alias-dictionary';
import { matchColumns } from './column-matcher';

const FATHA = String.fromCharCode(0x064e);
const TATWEEL = String.fromCharCode(0x0640);

/** Every alias AC2 names, as the story writes it. */
const AC2_ALIASES: [ImportField, string[]][] = [
  [
    'phone',
    [
      'phone',
      'mobile',
      'phone number',
      'mobile number',
      'whatsapp',
      'tel',
      'رقم الهاتف',
      'الموبايل',
      'رقم الموبايل',
      'موبايل',
      'تليفون',
      'واتساب',
      'رقم العميل',
    ],
  ],
  [
    'customerName',
    [
      'name',
      'customer',
      'customer name',
      'client name',
      'full name',
      'billing name',
      'shipping name',
      'اسم العميل',
      'الاسم',
      'العميل',
      'اسم المستلم',
    ],
  ],
  [
    'amount',
    [
      'amount',
      'total',
      'order total',
      'grand total',
      'price',
      'cod amount',
      'collect amount',
      'الاجمالي',
      'المبلغ',
      'السعر',
      'قيمه الطلب',
      'مبلغ التحصيل',
    ],
  ],
  [
    'orderReference',
    [
      'order id',
      'order number',
      'order no',
      'order #',
      'reference',
      'رقم الطلب',
      'كود الطلب',
      'رقم الاوردر',
    ],
  ],
  ['currency', ['currency', 'العمله']],
  [
    'paymentMethod',
    [
      'payment method',
      'payment',
      'payment gateway',
      'financial status',
      'طريقه الدفع',
      'الدفع',
    ],
  ],
  [
    'orderDate',
    ['date', 'order date', 'created at', 'created', 'التاريخ', 'تاريخ الطلب'],
  ],
  ['city', ['city', 'governorate', 'المدينه', 'المحافظه']],
  ['address', ['address', 'shipping address', 'العنوان']],
  ['notes', ['notes', 'note', 'ملاحظات']],
];

/** The same header as a merchant might really type it. */
const VARIANTS: [string, (alias: string) => string][] = [
  ['as written', (alias) => alias],
  ['in upper case with punctuation', (alias) => `${alias.toUpperCase()}:`],
  ['with snake case', (alias) => alias.replace(/ /g, '_')],
  ['with taa marbuta', (alias) => alias.replace(/ه(?= |$)/g, 'ة')],
  ['with hamza on the alef', (alias) => alias.replace(/^ا/, 'أ')],
  ['with a diacritic', (alias) => alias.replace(/ل/, `ل${FATHA}`)],
  ['with tatweel', (alias) => alias.replace(/م/, `م${TATWEEL}`)],
];

function suggestionFor(field: ImportField, headers: string[]) {
  return matchColumns(headers, []).fields.find(
    (suggestion) => suggestion.field === field,
  )!;
}

describe('alias dictionary (US-04.6-03 AC2)', () => {
  it('is versioned', () => {
    expect(MAPPING_DICTIONARY_VERSION).toBe(1);
  });

  describe.each(AC2_ALIASES)('%s', (field, aliases) => {
    describe.each(VARIANTS)('%s', (_variant, spell) => {
      it.each(aliases)('matches "%s" exactly', (alias) => {
        const header = spell(alias);
        expect(suggestionFor(field, [header])).toMatchObject({
          columns: [header],
          confidence: 'exact',
          source: 'auto',
        });
      });
    });
  });

  it.each([
    ['first name', 'last name'],
    ['الاسم الاول', 'الاسم الاخير'],
    ['First_Name', 'LAST NAME'],
    ['الإسم الأول', 'الاسم الأخير'],
  ])('joins "%s" and "%s" as the customer name', (first, last) => {
    expect(suggestionFor('customerName', ['Phone', first, last])).toMatchObject(
      { columns: [first, last], confidence: 'exact' },
    );
  });

  it('gives each alias key to one field only, except the ambiguous "name"', () => {
    const owners = new Map<string, ImportField>();
    for (const field of IMPORT_FIELDS) {
      for (const { key } of FIELD_ALIAS_KEYS[field]) {
        expect(key).not.toBe(AMBIGUOUS_NAME_KEY);
        expect(owners.get(key) ?? field).toBe(field);
        owners.set(key, field);
      }
    }
  });
});
