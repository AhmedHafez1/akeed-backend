import { headerKey } from './header-key';

/**
 * Bumped whenever an alias is added, removed or re-ranked, and stored on the
 * batch mapping, so a result can be traced to the dictionary that produced it.
 */
export const MAPPING_DICTIONARY_VERSION = 1;

/** Canonical fields in matching order; the first three are required (AC4). */
export const IMPORT_FIELDS = [
  'phone',
  'customerName',
  'amount',
  'orderReference',
  'currency',
  'paymentMethod',
  'orderDate',
  'city',
  'address',
  'notes',
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

export const REQUIRED_IMPORT_FIELDS: readonly ImportField[] = [
  'phone',
  'customerName',
  'amount',
];

/** An alias with its priority among a field's exact matches; lower wins. */
export interface FieldAlias {
  alias: string;
  rank: number;
}

const aliases = (rank: number, ...names: string[]): FieldAlias[] =>
  names.map((alias) => ({ alias, rank }));

/**
 * The header aliases of every canonical field (AC2), English and Arabic. Arabic
 * aliases are written already folded (`ه` for `ة`, bare alef); matching folds
 * headers the same way, so either spelling in a file matches.
 *
 * Ranks settle several exact matches, as in a Shopify export: `Shipping
 * Phone` > `Phone` > `Billing Phone`.
 */
export const FIELD_ALIASES: Readonly<Record<ImportField, FieldAlias[]>> = {
  phone: [
    ...aliases(0, 'shipping phone'),
    ...aliases(
      1,
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
    ),
    ...aliases(2, 'billing phone'),
  ],
  customerName: [
    ...aliases(
      0,
      'customer',
      'customer name',
      'client name',
      'full name',
      'اسم العميل',
      'الاسم',
      'العميل',
      'اسم المستلم',
    ),
    ...aliases(1, 'shipping name'),
    ...aliases(2, 'billing name'),
  ],
  amount: [
    ...aliases(0, 'cod amount', 'collect amount', 'مبلغ التحصيل'),
    ...aliases(
      1,
      'amount',
      'total',
      'order total',
      'grand total',
      'الاجمالي',
      'المبلغ',
      'قيمه الطلب',
    ),
    ...aliases(2, 'price', 'السعر'),
  ],
  orderReference: [
    ...aliases(
      0,
      'order id',
      'order number',
      'order no',
      'order #',
      'رقم الطلب',
      'كود الطلب',
      'رقم الاوردر',
    ),
    ...aliases(1, 'reference'),
  ],
  currency: aliases(0, 'currency', 'العمله'),
  paymentMethod: [
    ...aliases(0, 'payment method', 'طريقه الدفع'),
    ...aliases(1, 'payment', 'payment gateway', 'الدفع'),
    ...aliases(2, 'financial status'),
  ],
  orderDate: [
    ...aliases(0, 'order date', 'date', 'التاريخ', 'تاريخ الطلب'),
    ...aliases(1, 'created at', 'created'),
  ],
  city: [
    ...aliases(0, 'city', 'governorate', 'المدينه', 'المحافظه'),
    ...aliases(1, 'shipping city'),
    ...aliases(2, 'billing city'),
  ],
  // Shopify's `Street` is address line 1 and 2 together, so it beats `Address1`.
  address: [
    ...aliases(0, 'address', 'shipping address', 'العنوان'),
    ...aliases(1, 'shipping street'),
    ...aliases(2, 'shipping address1'),
    ...aliases(3, 'billing street'),
    ...aliases(4, 'billing address1'),
  ],
  notes: aliases(0, 'notes', 'note', 'ملاحظات'),
};

/** A split name: both columns map to `customerName` and are joined (AC4). */
export const FIRST_NAME_ALIASES = ['first name', 'الاسم الاول'];
export const LAST_NAME_ALIASES = ['last name', 'الاسم الاخير'];

/**
 * `Name` is both Shopify's order number column (`#1001`) and a plain customer
 * name column; the matcher settles it from the other headers and the samples
 * (AC3).
 */
export const AMBIGUOUS_NAME_KEY = headerKey('name');

export interface KeyedAlias {
  key: string;
  rank: number;
}

/** The dictionary in header-key form, computed once. */
export const FIELD_ALIAS_KEYS: Readonly<Record<ImportField, KeyedAlias[]>> =
  Object.fromEntries(
    IMPORT_FIELDS.map((field) => [
      field,
      FIELD_ALIASES[field].map(({ alias, rank }) => ({
        key: headerKey(alias),
        rank,
      })),
    ]),
  ) as Record<ImportField, KeyedAlias[]>;

export const FIRST_NAME_KEYS = FIRST_NAME_ALIASES.map(headerKey);
export const LAST_NAME_KEYS = LAST_NAME_ALIASES.map(headerKey);
