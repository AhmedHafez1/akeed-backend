import type { OrderLineItem } from '../interfaces/order.interface';
import {
  TEMPLATE_DETAIL_VARIABLE_KEYS,
  type TemplateDetailVariableKey,
  type TemplateLanguage,
  type TemplateVariable,
} from './template-registry.types';

/**
 * The longest value a send puts in each order-detail variable. The provider
 * does not publish a limit on a parameter value, so
 * these keep a filled message near the 1024 characters a body may have.
 */
export const ORDER_DETAIL_MAX_LENGTH = {
  items: 600,
  region: 80,
  address: 300,
} as const satisfies Record<TemplateDetailVariableKey, number>;

/** How many items a message lists before it says how many more there are. */
export const ORDER_DETAIL_ITEMS_LISTED = 5;

const ITEM_MAX_LENGTH = 150;
const ITEM_SEPARATOR = ' • ';
const ELLIPSIS = '…';
const PLAIN_DECIMAL = /^(\d+)(?:\.(\d+))?$/;

const WORDS = {
  ar: { listSeparator: '، ', more: (count: number) => `+${count} منتجات أخرى` },
  en: { listSeparator: ', ', more: (count: number) => `+${count} more items` },
  ur: { listSeparator: '، ', more: (count: number) => `+${count} مزید اشیاء` },
  es: {
    listSeparator: ', ',
    more: (count: number) => `+${count} artículos más`,
  },
  fr: {
    listSeparator: ', ',
    more: (count: number) => `+${count} autres articles`,
  },
} as const satisfies Record<
  TemplateLanguage,
  { listSeparator: string; more: (count: number) => string }
>;

/** What an order holds for the detail variables. */
export interface OrderDetails {
  lineItems?: readonly OrderLineItem[] | null;
  shippingRegion?: string | null;
  shippingAddress?: string | null;
}

export type OrderDetailValues = Partial<
  Record<TemplateDetailVariableKey, string>
>;

/**
 * A value the provider accepts as a template parameter: one line, no tab, no
 * run of spaces, within `maxLength`. The provider rejects the whole message
 * for a line break in a parameter, and these values come from customers.
 */
export function sanitizeParameterValue(
  value: string | null | undefined,
  maxLength: number,
): string {
  const line = (value ?? '').replace(/\s+/g, ' ').trim();
  if (line.length <= maxLength) return line;
  return `${line.slice(0, maxLength - ELLIPSIS.length).trimEnd()}${ELLIPSIS}`;
}

/** A decimal without a fraction that is all zeros: `180.00` reads `180`. */
function plainAmount(amount: string): string {
  const match = PLAIN_DECIMAL.exec(amount);
  if (!match) return amount;
  const [, whole, fraction = ''] = match;
  return /^0*$/.test(fraction) ? whole : `${whole}.${fraction}`;
}

/**
 * Unit price times quantity on the decimal text, so no amount passes through
 * a float. Null when either is not a plain positive number.
 */
export function lineTotal(unitPrice: string, quantity: number): string | null {
  const match = PLAIN_DECIMAL.exec(unitPrice.trim());
  if (!match || !Number.isSafeInteger(quantity) || quantity < 1) return null;
  const [, whole, fraction = ''] = match;
  const minor = (BigInt(`${whole}${fraction}`) * BigInt(quantity)).toString();
  if (!fraction) return minor;
  const padded = minor.padStart(fraction.length + 1, '0');
  return `${padded.slice(0, -fraction.length)}.${padded.slice(-fraction.length)}`;
}

function formatItem(
  item: OrderLineItem,
  position: number,
  language: TemplateLanguage,
): string {
  const { listSeparator } = WORDS[language];
  const price = item.unitPrice?.trim();
  const total = price ? lineTotal(price, item.quantity) : null;
  const amounts =
    price && total
      ? `(${item.quantity}x ${plainAmount(price)}) = ${plainAmount(total)}`
      : `(${item.quantity}x)`;
  const options = item.options
    .map((option) =>
      option.name ? `${option.name}: ${option.value}` : option.value,
    )
    .filter((option) => option.trim().length > 0);
  return sanitizeParameterValue(
    [`${position}. ${item.name} ${amounts}`, ...options].join(listSeparator),
    ITEM_MAX_LENGTH,
  );
}

/**
 * The order's items as one line: numbered, joined with a bullet, the first
 * five at most. Items that are left out, for their number or for the length
 * of the line, are counted in a closing "+2 more items". Empty when the order
 * has no item with a name.
 */
export function formatItemList(
  items: readonly OrderLineItem[] | null | undefined,
  language: TemplateLanguage,
): string {
  const named = (items ?? []).filter((item) => item.name.trim().length > 0);
  if (named.length === 0) return '';
  const listed = named
    .slice(0, ORDER_DETAIL_ITEMS_LISTED)
    .map((item, index) => formatItem(item, index + 1, language));
  const join = () => {
    const left = named.length - listed.length;
    return [...listed, ...(left > 0 ? [WORDS[language].more(left)] : [])].join(
      ITEM_SEPARATOR,
    );
  };
  while (listed.length > 1 && join().length > ORDER_DETAIL_MAX_LENGTH.items) {
    listed.pop();
  }
  return sanitizeParameterValue(join(), ORDER_DETAIL_MAX_LENGTH.items);
}

function usedDetailKeys(
  variables: readonly TemplateVariable[],
): TemplateDetailVariableKey[] {
  return TEMPLATE_DETAIL_VARIABLE_KEYS.filter((key) =>
    variables.some((variable) => variable.key === key),
  );
}

function detailValue(
  key: TemplateDetailVariableKey,
  details: OrderDetails,
  language: TemplateLanguage,
): string {
  if (key === 'items') return formatItemList(details.lineItems, language);
  return sanitizeParameterValue(
    key === 'region' ? details.shippingRegion : details.shippingAddress,
    ORDER_DETAIL_MAX_LENGTH[key],
  );
}

/**
 * The value of each order-detail variable a template uses. A variable the
 * order cannot fill is left out; `canFillTemplate` says so before a send.
 */
export function buildOrderDetailValues(
  details: OrderDetails,
  variables: readonly TemplateVariable[],
  language: TemplateLanguage,
): OrderDetailValues {
  const values: OrderDetailValues = {};
  for (const key of usedDetailKeys(variables)) {
    const value = detailValue(key, details, language);
    if (value) values[key] = value;
  }
  return values;
}

/**
 * Whether an order has every detail a template shows. A template without
 * detail variables can always be filled.
 */
export function canFillTemplate(
  variables: readonly TemplateVariable[],
  details: OrderDetails,
): boolean {
  // The language changes the wording of a value, never whether there is one.
  return usedDetailKeys(variables).every(
    (key) => detailValue(key, details, 'en').length > 0,
  );
}
