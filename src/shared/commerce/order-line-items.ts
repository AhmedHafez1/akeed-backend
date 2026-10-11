import {
  ORDER_LINE_ITEMS_MAX,
  type OrderLineItem,
} from '../interfaces/order.interface';

const NAME_MAX_LENGTH = 300;
const OPTION_MAX_LENGTH = 100;
const OPTIONS_MAX = 5;
const PLAIN_DECIMAL = /^\d+(?:\.\d+)?$/;

/** An item as a source spoke read it, before it is checked. */
export interface OrderLineItemInput {
  name: unknown;
  quantity: unknown;
  unitPrice: unknown;
  options?: readonly { name?: unknown; value: unknown }[];
}

function text(value: unknown, maxLength: number): string {
  const line =
    typeof value === 'string' || typeof value === 'number'
      ? String(value).replace(/\s+/g, ' ').trim()
      : '';
  return line.slice(0, maxLength);
}

/** A price as decimal text, whether the source sent a number or a string. */
function decimalText(value: unknown): string | null {
  const amount =
    typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? String(value)
      : text(value, 32);
  return PLAIN_DECIMAL.test(amount) ? amount : null;
}

/**
 * The order lines a source delivered, in the neutral shape the core stores:
 * bounded text, a whole quantity of at least one, a decimal price or none.
 * A line without a name is dropped, and only the first lines are kept.
 */
export function toOrderLineItems(
  items: readonly OrderLineItemInput[],
): OrderLineItem[] {
  const lines: OrderLineItem[] = [];
  for (const item of items) {
    if (lines.length === ORDER_LINE_ITEMS_MAX) break;
    const name = text(item.name, NAME_MAX_LENGTH);
    if (!name) continue;
    const quantity = Number(item.quantity);
    lines.push({
      name,
      quantity: Number.isSafeInteger(quantity) && quantity >= 1 ? quantity : 1,
      unitPrice: decimalText(item.unitPrice),
      options: (item.options ?? [])
        .map((option) => {
          const optionName = text(option.name, OPTION_MAX_LENGTH);
          return {
            ...(optionName ? { name: optionName } : {}),
            value: text(option.value, OPTION_MAX_LENGTH),
          };
        })
        .filter((option) => option.value.length > 0)
        .slice(0, OPTIONS_MAX),
    });
  }
  return lines;
}
