import { Transform } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ONBOARDING_SHIPPING_CURRENCIES } from '../../onboarding/dto/onboarding.dto';
import { normalizePaymentSignal } from '../../../shared/commerce/payment-signals';

function trim(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

function trimOptional(value: unknown): unknown {
  const normalized = trim(value);
  return normalized === '' ? undefined : normalized;
}

function normalizeCurrency(value: unknown): unknown {
  return typeof value === 'string' ? value.trim().toUpperCase() : value;
}

function normalizePaymentMethod(value: unknown): unknown {
  return typeof value === 'string' ? normalizePaymentSignal(value) : value;
}

export class CreateManualOrderDto {
  @Transform(({ value }) => trim(value))
  @IsString({ message: 'customerPhone must be a string.' })
  @IsNotEmpty({ message: 'customerPhone is required.' })
  @MinLength(7, { message: 'customerPhone is invalid.' })
  @MaxLength(20, { message: 'customerPhone is invalid.' })
  customerPhone!: string;

  @Transform(({ value }) => trimOptional(value))
  @IsOptional()
  @IsString({ message: 'customerName must be a string.' })
  @MaxLength(255, { message: 'customerName must not exceed 255 characters.' })
  customerName?: string;

  @Transform(({ value }) => trimOptional(value))
  @IsOptional()
  @IsString({ message: 'orderNumber must be a string.' })
  @MaxLength(100, { message: 'orderNumber must not exceed 100 characters.' })
  orderNumber?: string;

  @Transform(({ value }) => trim(value))
  @IsString({ message: 'totalPrice must be a decimal string.' })
  @Matches(
    /^(?=.{1,13}$)(?!0+(?:\.0{1,2})?$)(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/,
    {
      message: 'totalPrice must be greater than zero with at most 2 decimals.',
    },
  )
  totalPrice!: string;

  @Transform(({ value }) => normalizeCurrency(value as unknown))
  @IsString({ message: 'currency must be a string.' })
  @IsIn(ONBOARDING_SHIPPING_CURRENCIES, {
    message: 'currency is not supported.',
  })
  currency!: (typeof ONBOARDING_SHIPPING_CURRENCIES)[number];

  @Transform(({ value }) => normalizePaymentMethod(value as unknown))
  @IsString({ message: 'paymentMethod must be a string.' })
  @IsNotEmpty({ message: 'paymentMethod is required.' })
  @MaxLength(100, { message: 'paymentMethod must not exceed 100 characters.' })
  paymentMethod!: string;
}

export interface CreateManualOrderResponseDto {
  orderId: string;
  verificationId?: string;
  status: 'accepted';
  duplicate: boolean;
}
