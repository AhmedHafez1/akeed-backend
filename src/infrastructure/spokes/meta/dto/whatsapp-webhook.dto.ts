import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

export class WhatsAppWebhookVerifyDto {
  @Transform(({ obj }) => {
    const source = obj as Record<string, unknown>;
    return typeof source['hub.mode'] === 'string' ? source['hub.mode'] : '';
  })
  @IsString()
  @IsNotEmpty()
  mode!: string;

  @Transform(({ obj }) => {
    const source = obj as Record<string, unknown>;
    return typeof source['hub.verify_token'] === 'string'
      ? source['hub.verify_token']
      : '';
  })
  @IsString()
  @IsNotEmpty()
  token!: string;

  @Transform(({ obj }) => {
    const source = obj as Record<string, unknown>;
    return typeof source['hub.challenge'] === 'string'
      ? source['hub.challenge']
      : '';
  })
  @IsString()
  @IsNotEmpty()
  challenge!: string;
}

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
