import { Transform, Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

export class ShopifyAddressDto {
  @IsOptional()
  @IsString()
  phone?: string;
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
