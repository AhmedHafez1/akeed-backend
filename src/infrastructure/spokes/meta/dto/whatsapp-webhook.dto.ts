import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

type QuerySource = Record<string, unknown>;

function readQueryString(
  source: QuerySource,
  dottedKey: string,
  nestedKey: string,
): string {
  const dottedValue = source[dottedKey];
  if (typeof dottedValue === 'string') {
    return dottedValue;
  }

  if (Array.isArray(dottedValue) && typeof dottedValue[0] === 'string') {
    return dottedValue[0];
  }

  const hub = source['hub'];
  if (hub && typeof hub === 'object') {
    const nestedValue = (hub as QuerySource)[nestedKey];
    if (typeof nestedValue === 'string') {
      return nestedValue;
    }

    if (Array.isArray(nestedValue) && typeof nestedValue[0] === 'string') {
      return nestedValue[0];
    }
  }

  return '';
}

export class WhatsAppWebhookVerifyDto {
  @Transform(({ obj }) => {
    const source = obj as QuerySource;
    return readQueryString(source, 'hub.mode', 'mode');
  })
  @IsString()
  @IsNotEmpty()
  mode!: string;

  @Transform(({ obj }) => {
    const source = obj as QuerySource;
    return readQueryString(source, 'hub.verify_token', 'verify_token');
  })
  @IsString()
  @IsNotEmpty()
  token!: string;

  @Transform(({ obj }) => {
    const source = obj as QuerySource;
    return readQueryString(source, 'hub.challenge', 'challenge');
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
