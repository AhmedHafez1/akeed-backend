import { applyDecorators } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDefined,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateBy,
  ValidateNested,
  type ValidationOptions,
} from 'class-validator';
import {
  ONBOARDING_SHIPPING_CURRENCIES,
  type OnboardingShippingCurrency,
} from '../../onboarding/dto/onboarding.dto';
import type { ImportField } from '../mapping/alias-dictionary';
import type {
  FieldSuggestion,
  MatchConfidence,
} from '../mapping/column-matcher';
import {
  IMPORT_DATE_FORMATS,
  MAX_CUSTOMER_NAME_COLUMNS,
  type ImportColumnMapping,
  type ImportDateFormat,
  type ImportOptions,
  type MappingSource,
  type PaymentClassification,
} from '../mapping/mapping-rules';
import type { PaymentValueSummary } from '../mapping/payment-value-classifier';

/** Headers are at most 1,000 characters (US-04.6-02 AC7). */
const MAX_HEADER_LENGTH = 1_000;
const MAX_PAYMENT_VALUE_KEYS = 200;
const MAX_PAYMENT_VALUE_KEY_LENGTH = 1_000;
const PAYMENT_CLASSIFICATIONS: readonly PaymentClassification[] = [
  'cod',
  'not_cod',
];

function upperCase(value: unknown): unknown {
  return typeof value === 'string' ? value.trim().toUpperCase() : value;
}

/** `{normalizedValue: 'cod' | 'not_cod'}` with bounded size. */
function IsPaymentValueMap(options?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'isPaymentValueMap',
      validator: {
        validate(value: unknown) {
          if (typeof value !== 'object' || value === null) return false;
          if (Array.isArray(value)) return false;
          const entries = Object.entries(value);
          return (
            entries.length <= MAX_PAYMENT_VALUE_KEYS &&
            entries.every(
              ([key, choice]) =>
                key.length <= MAX_PAYMENT_VALUE_KEY_LENGTH &&
                PAYMENT_CLASSIFICATIONS.includes(
                  choice as PaymentClassification,
                ),
            )
          );
        },
        defaultMessage: () =>
          `paymentValueMap must map up to ${MAX_PAYMENT_VALUE_KEYS} values to cod or not_cod.`,
      },
    },
    options,
  );
}

const optionalColumn = () =>
  applyDecorators(
    IsOptional(),
    IsString({ message: '$property must be a column name or null.' }),
    MaxLength(MAX_HEADER_LENGTH),
  );

/** The column for each canonical field; omitted or `null` is not imported. */
export class OrderImportColumnMappingDto {
  @optionalColumn()
  phone?: string | null;

  @IsArray({ message: 'customerName must be a list of one or two columns.' })
  @ArrayMinSize(1, { message: 'customerName must be mapped to a column.' })
  @ArrayMaxSize(MAX_CUSTOMER_NAME_COLUMNS, {
    message: 'customerName takes at most two columns.',
  })
  @IsString({ each: true })
  @MaxLength(MAX_HEADER_LENGTH, { each: true })
  customerName!: string[];

  @optionalColumn()
  amount?: string | null;

  @optionalColumn()
  orderReference?: string | null;

  @optionalColumn()
  currency?: string | null;

  @optionalColumn()
  paymentMethod?: string | null;

  @optionalColumn()
  orderDate?: string | null;

  @optionalColumn()
  city?: string | null;

  @optionalColumn()
  address?: string | null;

  @optionalColumn()
  notes?: string | null;
}

export class OrderImportOptionsDto {
  @Transform(({ value }) => upperCase(value))
  @IsString({ message: 'country must be a two-letter country code.' })
  @Matches(/^[A-Z]{2}$/, {
    message: 'country must be a two-letter country code.',
  })
  country!: string;

  @Transform(({ value }) => upperCase(value))
  @IsIn(ONBOARDING_SHIPPING_CURRENCIES, {
    message: 'defaultCurrency is not supported.',
  })
  defaultCurrency!: OnboardingShippingCurrency;

  @IsIn(IMPORT_DATE_FORMATS, {
    message: 'dateFormat must be auto, DMY, MDY or YMD.',
  })
  dateFormat!: ImportDateFormat;

  @IsOptional()
  @IsIn(PAYMENT_CLASSIFICATIONS)
  blankPaymentClass?: PaymentClassification;

  @IsOptional()
  @IsObject()
  @IsPaymentValueMap()
  paymentValueMap?: Record<string, PaymentClassification>;
}

/** `PUT /api/order-imports/:id/mapping` (US-04.6-03 AC4, AC5, AC7). */
export class SaveOrderImportMappingDto {
  @IsDefined({ message: 'mapping is required.' })
  @ValidateNested()
  @Type(() => OrderImportColumnMappingDto)
  mapping!: OrderImportColumnMappingDto;

  @IsDefined({ message: 'options is required.' })
  @ValidateNested()
  @Type(() => OrderImportOptionsDto)
  options!: OrderImportOptionsDto;
}

export interface OrderImportFieldSuggestionDto {
  field: ImportField;
  required: boolean;
  columns: string[];
  confidence: MatchConfidence;
  source: FieldSuggestion['source'];
  alternatives: string[];
}

export interface OrderImportDateFormatDto {
  column: string;
  ambiguous: boolean;
  detectedFormat: 'DMY' | 'MDY' | null;
}

export interface OrderImportPaymentValuesDto extends PaymentValueSummary {
  column: string;
}

/** The mapping part of the upload response (AC1, AC5, AC6, AC8). */
export interface OrderImportMappingSuggestionDto {
  mappingDictionaryVersion: number;
  headerSignature: string;
  mappingProfileApplied: boolean;
  suggestions: {
    fields: OrderImportFieldSuggestionDto[];
    unmappedColumns: string[];
  };
  options: ImportOptions;
  paymentValues: OrderImportPaymentValuesDto | null;
  dateFormat: OrderImportDateFormatDto | null;
}

/** A field as the batch page shows it: its origin may be the merchant's. */
export interface OrderImportFieldStateDto extends Omit<
  OrderImportFieldSuggestionDto,
  'source'
> {
  source: MappingSource;
}

/** The mapping part of `GET /api/order-imports/:id` (US-04.6-05). */
export interface OrderImportMappingStateDto {
  /** False while the mapping is only the upload's suggestion. */
  mappingConfirmed: boolean;
  suggestions: {
    fields: OrderImportFieldStateDto[];
    unmappedColumns: string[];
  };
  options: ImportOptions;
  paymentValues: OrderImportPaymentValuesDto | null;
  dateFormat: OrderImportDateFormatDto | null;
}

export interface OrderImportMappingResponseDto {
  batchId: string;
  status: 'draft';
  mappingDictionaryVersion: number;
  mapping: ImportColumnMapping;
  sources: Record<ImportField, MappingSource>;
  options: ImportOptions;
  mappingProfileId: string;
  unmappedColumns: string[];
  paymentValues: OrderImportPaymentValuesDto | null;
  dateFormat: OrderImportDateFormatDto | null;
  counts: Record<string, number>;
}
