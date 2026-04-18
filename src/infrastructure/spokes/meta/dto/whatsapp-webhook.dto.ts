import { Type } from 'class-transformer';
import { IsArray, IsOptional, IsString, ValidateNested } from 'class-validator';

export class WhatsAppButtonDto {
  @IsOptional()
  @IsString()
  payload?: string;
}

export class WhatsAppMessageDto {
  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsString()
  timestamp?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => WhatsAppButtonDto)
  button?: WhatsAppButtonDto;
}

export class WhatsAppStatusDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  timestamp?: string;
}

export class WhatsAppChangeValueDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WhatsAppMessageDto)
  messages?: WhatsAppMessageDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WhatsAppStatusDto)
  statuses?: WhatsAppStatusDto[];
}

export class WhatsAppChangeDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => WhatsAppChangeValueDto)
  value?: WhatsAppChangeValueDto;
}

export class WhatsAppEntryDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WhatsAppChangeDto)
  changes?: WhatsAppChangeDto[];
}

export class WhatsAppWebhookPayloadDto {
  @IsOptional()
  @IsString()
  object?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WhatsAppEntryDto)
  entry?: WhatsAppEntryDto[];
}
