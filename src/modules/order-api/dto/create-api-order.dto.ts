import { Transform } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateBy,
  type ValidationOptions,
} from 'class-validator';
import {
  CANONICAL_EXTRA_TEXT_MAX_LENGTH,
  CANONICAL_NAME_MAX_LENGTH,
  CANONICAL_ORDER_CURRENCIES,
  CANONICAL_ORDER_NUMBER_MAX_LENGTH,
  CANONICAL_PAYMENT_METHOD_MAX_LENGTH,
  CANONICAL_PHONE_MAX_LENGTH,
  CANONICAL_PHONE_MIN_LENGTH,
  CANONICAL_TOTAL_PRICE_PATTERN,
  isCanonicalOrderDate,
  normalizeCanonicalCurrency,
  normalizeCanonicalPaymentMethod,
  type CanonicalOrderCurrency,
} from '../../../shared/commerce/canonical-order.rules';
import {
  TrimOptionalString,
  TrimString,
} from '../../../shared/validation/trim.transform';

function IsCanonicalOrderDate(options: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isCanonicalOrderDate',
      validator: { validate: (value: unknown) => isCanonicalOrderDate(value) },
    },
    options,
  );
}

/**
 * One order as a merchant's server submits it.
 *
 * Every rule is read from `canonical-order.rules.ts`, the same file the manual
 * form and the file import read, so a value one channel accepts is accepted by
 * the others. The tenant is never a field: it comes from the API key.
 */
export class CreateApiOrderDto {
  /** The merchant's own order id: the order's identity in Akeed. */
  @TrimString()
  @IsString({ message: 'externalOrderId must be a string.' })
  @IsNotEmpty({ message: 'externalOrderId is required.' })
  @MaxLength(CANONICAL_ORDER_NUMBER_MAX_LENGTH, {
    message: `externalOrderId must not exceed ${CANONICAL_ORDER_NUMBER_MAX_LENGTH} characters.`,
  })
  externalOrderId!: string;

  @TrimString()
  @IsString({ message: 'customerName must be a string.' })
  @IsNotEmpty({ message: 'customerName is required.' })
  @MaxLength(CANONICAL_NAME_MAX_LENGTH, {
    message: `customerName must not exceed ${CANONICAL_NAME_MAX_LENGTH} characters.`,
  })
  customerName!: string;

  @TrimString()
  @IsString({ message: 'customerPhone must be a string.' })
  @IsNotEmpty({ message: 'customerPhone is required.' })
  @MinLength(CANONICAL_PHONE_MIN_LENGTH, {
    message: 'customerPhone is invalid.',
  })
  @MaxLength(CANONICAL_PHONE_MAX_LENGTH, {
    message: 'customerPhone is invalid.',
  })
  customerPhone!: string;

  @TrimString()
  @IsString({ message: 'totalPrice must be a decimal string.' })
  @Matches(CANONICAL_TOTAL_PRICE_PATTERN, {
    message: 'totalPrice must be greater than zero with at most 2 decimals.',
  })
  totalPrice!: string;

  @Transform(({ value }) => normalizeCanonicalCurrency(value as unknown))
  @IsString({ message: 'currency must be a string.' })
  @IsIn(CANONICAL_ORDER_CURRENCIES, {
    message: 'currency is not supported.',
  })
  currency!: CanonicalOrderCurrency;

  @Transform(({ value }) => normalizeCanonicalPaymentMethod(value as unknown))
  @IsString({ message: 'paymentMethod must be a string.' })
  @IsNotEmpty({ message: 'paymentMethod is required.' })
  @MaxLength(CANONICAL_PAYMENT_METHOD_MAX_LENGTH, {
    message: `paymentMethod must not exceed ${CANONICAL_PAYMENT_METHOD_MAX_LENGTH} characters.`,
  })
  paymentMethod!: string;

  /** What the customer sees; defaults to `externalOrderId` as written. */
  @TrimOptionalString()
  @IsOptional()
  @IsString({ message: 'orderNumber must be a string.' })
  @MaxLength(CANONICAL_ORDER_NUMBER_MAX_LENGTH, {
    message: `orderNumber must not exceed ${CANONICAL_ORDER_NUMBER_MAX_LENGTH} characters.`,
  })
  orderNumber?: string;

  @TrimOptionalString()
  @IsOptional()
  @IsCanonicalOrderDate({ message: 'orderDate must be a YYYY-MM-DD date.' })
  orderDate?: string;

  @TrimOptionalString()
  @IsOptional()
  @IsString({ message: 'city must be a string.' })
  @MaxLength(CANONICAL_EXTRA_TEXT_MAX_LENGTH, {
    message: `city must not exceed ${CANONICAL_EXTRA_TEXT_MAX_LENGTH} characters.`,
  })
  city?: string;

  @TrimOptionalString()
  @IsOptional()
  @IsString({ message: 'address must be a string.' })
  @MaxLength(CANONICAL_EXTRA_TEXT_MAX_LENGTH, {
    message: `address must not exceed ${CANONICAL_EXTRA_TEXT_MAX_LENGTH} characters.`,
  })
  address?: string;

  @TrimOptionalString()
  @IsOptional()
  @IsString({ message: 'notes must be a string.' })
  @MaxLength(CANONICAL_EXTRA_TEXT_MAX_LENGTH, {
    message: `notes must not exceed ${CANONICAL_EXTRA_TEXT_MAX_LENGTH} characters.`,
  })
  notes?: string;
}

/** `accepted` means durably stored, not sent or delivered. */
export interface CreateApiOrderResponseDto {
  orderId: string;
  verificationId?: string;
  status: 'accepted';
  duplicate: boolean;
}
