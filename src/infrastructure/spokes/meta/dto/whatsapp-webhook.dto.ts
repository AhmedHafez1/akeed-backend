import { Type } from 'class-transformer';
import { IsArray, IsOptional, IsString, ValidateNested } from 'class-validator';

export class WhatsAppButtonDto {
  @IsOptional()
  @IsString()
  payload?: string;
}

export class WhatsAppInteractiveButtonReplyDto {
  @IsOptional()
  @IsString()
  id?: string;
}

export class WhatsAppInteractiveDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => WhatsAppInteractiveButtonReplyDto)
  button_reply?: WhatsAppInteractiveButtonReplyDto;
}

export class WhatsAppTextDto {
  @IsOptional()
  @IsString()
  body?: string;
}

export class WhatsAppContextDto {
  /** wamid of the message this one replies to. */
  @IsOptional()
  @IsString()
  id?: string;
}

export class WhatsAppMessageDto {
  @IsOptional()
  @IsString()
  id?: string;

  /** Sender's phone number in E.164 without the leading `+`. */
  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsString()
  timestamp?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => WhatsAppContextDto)
  context?: WhatsAppContextDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => WhatsAppButtonDto)
  button?: WhatsAppButtonDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => WhatsAppInteractiveDto)
  interactive?: WhatsAppInteractiveDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => WhatsAppTextDto)
  text?: WhatsAppTextDto;
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
