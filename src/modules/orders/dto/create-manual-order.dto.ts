import { Transform } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  CANONICAL_NAME_MAX_LENGTH,
  CANONICAL_ORDER_CURRENCIES,
  CANONICAL_ORDER_NUMBER_MAX_LENGTH,
  CANONICAL_PAYMENT_METHOD_MAX_LENGTH,
  CANONICAL_PHONE_MAX_LENGTH,
  CANONICAL_PHONE_MIN_LENGTH,
  CANONICAL_TOTAL_PRICE_PATTERN,
  normalizeCanonicalCurrency,
  normalizeCanonicalPaymentMethod,
  type CanonicalOrderCurrency,
} from '../../../shared/commerce/canonical-order.rules';
import { TrimString } from '../../../shared/validation/trim.transform';

export class CreateManualOrderDto {
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

  // Both of these were optional. They are required now because they are the
  // only human-readable identity the customer gets: the WhatsApp template
  // greets the name and quotes the order reference, and with neither captured
  // the message named an internal identifier nobody recognises.
  @TrimString()
  @IsString({ message: 'customerName must be a string.' })
  @IsNotEmpty({ message: 'customerName is required.' })
  @MaxLength(CANONICAL_NAME_MAX_LENGTH, {
    message: 'customerName must not exceed 255 characters.',
  })
  customerName!: string;

  @TrimString()
  @IsString({ message: 'orderNumber must be a string.' })
  @IsNotEmpty({ message: 'orderNumber is required.' })
  @MaxLength(CANONICAL_ORDER_NUMBER_MAX_LENGTH, {
    message: 'orderNumber must not exceed 100 characters.',
  })
  orderNumber!: string;

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
    message: 'paymentMethod must not exceed 100 characters.',
  })
  paymentMethod!: string;
}

export interface CreateManualOrderResponseDto {
  orderId: string;
  verificationId?: string;
  status: 'accepted';
  duplicate: boolean;
}
