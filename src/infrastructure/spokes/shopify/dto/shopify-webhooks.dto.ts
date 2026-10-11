import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

export class ShopifyAddressDto {
  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  country_code?: string;
}

/** A webhook must never be refused for the shape of a display field. */
const stringOrAbsent = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value : undefined;

/**
 * The delivery address a detailed confirmation shows. The global pipe strips
 * what a DTO does not declare, so these are declared to be kept; the billing
 * and customer addresses keep only what the phone lookup needs.
 */
export class ShopifyShippingAddressDto extends ShopifyAddressDto {
  @Transform(stringOrAbsent)
  @IsOptional()
  @IsString()
  address1?: string;

  @Transform(stringOrAbsent)
  @IsOptional()
  @IsString()
  address2?: string;

  @Transform(stringOrAbsent)
  @IsOptional()
  @IsString()
  city?: string;

  @Transform(stringOrAbsent)
  @IsOptional()
  @IsString()
  province?: string;
}

/** What is kept of one order line: enough to name it in a message. */
export interface ShopifyLineItem {
  title?: unknown;
  name?: unknown;
  variant_title?: unknown;
  quantity?: unknown;
  price?: unknown;
}

function projectLineItems({
  value,
}: {
  value: unknown;
}): ShopifyLineItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter(
      (item): item is Record<string, unknown> =>
        item !== null && typeof item === 'object',
    )
    .map((item) => ({
      title: item.title,
      name: item.name,
      variant_title: item.variant_title,
      quantity: item.quantity,
      price: item.price,
    }));
}

export class ShopifyCustomerDto {
  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  first_name?: string;

  @IsOptional()
  @IsString()
  last_name?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ShopifyAddressDto)
  default_address?: ShopifyAddressDto;
}

export class ShopifyOrderWebhookDto {
  @Transform(({ value }) => String(value))
  @IsString()
  @IsNotEmpty()
  id!: string;

  @Transform(({ value }) => String(value))
  @IsString()
  @IsNotEmpty()
  order_number!: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  countryCode?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ShopifyCustomerDto)
  customer?: ShopifyCustomerDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ShopifyAddressDto)
  billing_address?: ShopifyAddressDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ShopifyShippingAddressDto)
  shipping_address?: ShopifyShippingAddressDto;

  /** Kept as a projection; anything that is not a list is dropped. */
  @Transform(projectLineItems)
  @IsOptional()
  @IsArray()
  line_items?: ShopifyLineItem[];

  @IsOptional()
  @IsString()
  total_price?: string;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsString()
  gateway?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  payment_gateway_names?: string[];

  @IsOptional()
  @IsBoolean()
  test?: boolean;
}

export class ShopifyAppUninstalledDto {
  @Transform(({ value }) => String(value))
  @IsString()
  @IsNotEmpty()
  id!: string;
}

export class ShopifyAppSubscriptionWebhookDto {
  @Transform(({ value }) => String(value))
  @IsString()
  @IsNotEmpty()
  id!: string;

  @Transform(({ value }) => String(value))
  @IsString()
  @IsNotEmpty()
  status!: string;

  @IsOptional()
  @Transform(({ value }) => String(value))
  @IsString()
  admin_graphql_api_id?: string;
}

export class ShopifyGdprCustomerDto {
  @IsOptional()
  @Transform(({ value }) => String(value))
  @IsString()
  id?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  phone?: string;
}

export class ShopifyGdprBaseWebhookDto {
  @IsOptional()
  @Transform(({ value }) => String(value))
  @IsString()
  shop_id?: string;

  @IsOptional()
  @IsString()
  shop_domain?: string;
}

export class ShopifyCustomersDataRequestDto extends ShopifyGdprBaseWebhookDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => ShopifyGdprCustomerDto)
  customer?: ShopifyGdprCustomerDto;

  @IsOptional()
  @IsArray()
  @Transform(({ value }): string[] | undefined => {
    if (Array.isArray(value)) {
      return value.map((entry) => String(entry));
    }

    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    return [String(value)];
  })
  @IsString({ each: true })
  orders_requested?: string[];
}

export class ShopifyCustomersRedactDto extends ShopifyGdprBaseWebhookDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => ShopifyGdprCustomerDto)
  customer?: ShopifyGdprCustomerDto;
}

export class ShopifyShopRedactDto extends ShopifyGdprBaseWebhookDto {}
