import { buildStandaloneOrderEnvelope } from '../../../shared/commerce/standalone-order-envelope';
import type { NormalizedOrder } from '../../../shared/interfaces/order.interface';
import type {
  IntegrationEligibilityInput,
  OrderEligibilityResult,
} from '../../verification-core/order-eligibility.types';
import type {
  ImportColumnMapping,
  ImportOptions,
} from '../mapping/mapping-rules';
import { validateAmount } from './amount';
import { resolveCurrency } from './currency';
import { validateOrderDate } from './date';
import {
  isRowIssueCode,
  outcomeOf,
  PARSE_ISSUE_CODES,
  type RowIssue,
  type RowOutcome,
} from './issue-codes';
import { validateName } from './name';
import { canonicalPayment } from './payment';
import { validatePhone, type StandardizeMobile } from './phone';
import { validateOrderReference } from './reference';
import { cleanCell } from './text';

/**
 * `order_import_rows.normalized`: the fields of the bulk envelope's `order`
 * the row could fill, plus the merchant's payment text when it was replaced.
 * Identity (`externalOrderId`) is assigned at commit.
 */
export interface NormalizedImportOrder {
  orderNumber?: string;
  customerPhone?: string;
  customerName?: string;
  totalPrice?: string;
  currency?: string;
  paymentMethod: string;
  paymentMethodOriginal?: string;
  orderDate?: string;
  city?: string;
  address?: string;
  notes?: string;
}

export interface RowValidationContext {
  orgId: string;
  integrationId: string;
  integration: IntegrationEligibilityInput;
  mapping: ImportColumnMapping;
  options: ImportOptions;
  /** What the date column proves when the format is `auto`. */
  detectedDateFormat: 'DMY' | 'MDY' | null;
  timezone: string;
  now: Date;
  maxOrderAgeDays: number;
}

export interface RowValidatorDeps {
  standardizeMobile: StandardizeMobile;
  /** `OrderEligibilityService.evaluateOrderForVerification`, injected. */
  evaluateEligibility: (params: {
    order: NormalizedOrder;
    integration: IntegrationEligibilityInput;
  }) => OrderEligibilityResult;
}

export interface ValidatedRow {
  normalized: NormalizedImportOrder;
  issues: RowIssue[];
  outcome: RowOutcome;
  dedupeKey: string | null;
}

/** The parser's own issues on the stored row, kept across re-validations. */
export function parseIssuesOf(stored: unknown): RowIssue[] {
  if (!Array.isArray(stored)) return [];
  return stored.flatMap((entry: unknown): RowIssue[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { code, field } = entry as { code?: unknown; field?: unknown };
    if (!isRowIssueCode(code) || !PARSE_ISSUE_CODES.includes(code)) return [];
    return [{ code, ...(typeof field === 'string' ? { field } : {}) }];
  });
}

function mappedColumns(mapping: ImportColumnMapping): Set<string> {
  const { customerName, ...single } = mapping;
  return new Set(
    [...customerName, ...Object.values(single)].filter(
      (column): column is string => typeof column === 'string',
    ),
  );
}

const ELIGIBILITY_ISSUE: Partial<
  Record<OrderEligibilityResult['reason'], RowIssue>
> = {
  non_cod_payment_method: { code: 'PAYMENT_NOT_COD', field: 'paymentMethod' },
  missing_payment_signal: {
    code: 'PAYMENT_UNKNOWN_EXCLUDED',
    field: 'paymentMethod',
  },
};

/**
 * Turns one stored row into its normalized order, every issue it has and its
 * outcome (AC1–AC8, AC13). Pure apart from the two injected services, both of
 * which are pure too, so the same row, mapping and options always give the
 * same result. Cross-row and database dedupe run afterwards over the batch.
 */
export function validateRow(
  raw: Readonly<Record<string, string>>,
  storedIssues: unknown,
  context: RowValidationContext,
  deps: RowValidatorDeps,
): ValidatedRow {
  const { mapping, options } = context;
  const cell = (column: string | null) =>
    column ? cleanCell(raw[column]) : '';
  const used = mappedColumns(mapping);
  const issues: RowIssue[] = parseIssuesOf(storedIssues).map((issue) =>
    issue.code === 'FIELD_TOO_LONG' && !used.has(issue.field ?? '')
      ? { ...issue, informational: true }
      : issue,
  );
  const normalized: NormalizedImportOrder = { paymentMethod: '' };

  const phone = validatePhone(
    cell(mapping.phone),
    options.country,
    deps.standardizeMobile,
  );
  if (phone.ok) normalized.customerPhone = phone.value;
  else issues.push(phone.issue);

  const name = validateName(mapping.customerName.map((column) => cell(column)));
  if (name.ok) normalized.customerName = name.value;
  else issues.push(name.issue);

  const amount = validateAmount(cell(mapping.amount));
  if (amount.ok) normalized.totalPrice = amount.value.totalPrice;
  else issues.push(amount.issue);

  const currency = resolveCurrency(
    cell(mapping.currency),
    amount.ok ? amount.value.currency : null,
    options.defaultCurrency,
  );
  if (currency.ok) normalized.currency = currency.value;
  else issues.push(currency.issue);

  const reference = validateOrderReference(cell(mapping.orderReference));
  if (reference.orderNumber) normalized.orderNumber = reference.orderNumber;
  if (reference.issue) issues.push(reference.issue);

  const date = validateOrderDate(cell(mapping.orderDate), {
    dateFormat: options.dateFormat,
    detectedFormat: context.detectedDateFormat,
    timezone: context.timezone,
    now: context.now,
    maxOrderAgeDays: context.maxOrderAgeDays,
  });
  if (date.value) normalized.orderDate = date.value;
  if (date.issue) issues.push(date.issue);

  for (const field of ['city', 'address', 'notes'] as const) {
    const value = cell(mapping[field]);
    if (value) normalized[field] = value;
  }

  const payment = canonicalPayment(
    cell(mapping.paymentMethod),
    options.paymentValueMap,
  );
  normalized.paymentMethod = payment.paymentMethod;
  if (payment.paymentMethodOriginal !== undefined)
    normalized.paymentMethodOriginal = payment.paymentMethodOriginal;

  // The same eligibility decision the worker makes for this order.
  const { canonicalOrder } = buildStandaloneOrderEnvelope({
    ingestionType: 'bulk_import',
    order: {
      externalOrderId: reference.dedupeKey ?? '',
      orderNumber: normalized.orderNumber ?? '',
      customerPhone: normalized.customerPhone ?? '',
      customerName: normalized.customerName ?? '',
      totalPrice: normalized.totalPrice ?? '0',
      currency: normalized.currency ?? '',
      paymentMethod: normalized.paymentMethod,
    },
  });
  const eligibility = deps.evaluateEligibility({
    order: {
      ...canonicalOrder,
      orgId: context.orgId,
      integrationId: context.integrationId,
    },
    integration: context.integration,
  });
  const paymentIssue = payment.merchantNotCod
    ? ELIGIBILITY_ISSUE.non_cod_payment_method
    : eligibility.eligible
      ? undefined
      : ELIGIBILITY_ISSUE[eligibility.reason];
  if (paymentIssue) issues.push(paymentIssue);

  return {
    normalized,
    issues,
    outcome: outcomeOf(issues),
    dedupeKey: reference.dedupeKey,
  };
}
