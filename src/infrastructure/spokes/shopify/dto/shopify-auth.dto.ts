import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class ShopifyLoginQueryDto {
  @IsString()
  @IsNotEmpty()
  shop!: string;

  @IsString()
  @IsOptional()
  host?: string;
}

export class ShopifyCallbackQueryDto {
  @IsString()
  @IsNotEmpty()
  shop!: string;

  @IsString()
  @IsNotEmpty()
  code!: string;

  @IsString()
  @IsNotEmpty()
  state!: string;

  @IsString()
  @IsNotEmpty()
  hmac!: string;

  @IsString()
  @IsOptional()
  host?: string;
}
