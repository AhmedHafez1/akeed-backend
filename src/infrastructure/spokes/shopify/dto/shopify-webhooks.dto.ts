import { Transform, Type } from 'class-transformer';
import {
  IsArray,
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
  @Type(() => ShopifyAddressDto)
  shipping_address?: ShopifyAddressDto;

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
