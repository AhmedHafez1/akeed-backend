import { IsNotEmpty, IsString } from 'class-validator';

export class ShopifyLoginQueryDto {
  @IsString()
  @IsNotEmpty()
  shop!: string;
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
}
