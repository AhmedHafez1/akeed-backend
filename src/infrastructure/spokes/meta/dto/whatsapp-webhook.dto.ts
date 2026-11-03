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
  from_user_id?: string;
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

export class WhatsAppStatusErrorDto {
  /** Numeric in Meta's payload; left untyped here so validation never rejects
   * an otherwise-valid status webhook over this field's shape. */
  @IsOptional()
  code?: number | string;

  @IsOptional()
  @IsString()
  title?: string;
}

export class WhatsAppStatusDto {
  @IsOptional()
  @IsString()
  biz_opaque_callback_data?: string;
  @IsOptional()
  @IsString()
  id?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  timestamp?: string;

  /** Present when `status` is `failed`; explains why delivery did not happen. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WhatsAppStatusErrorDto)
  errors?: WhatsAppStatusErrorDto[];
}

export class WhatsAppChangeValueDto {
  @IsOptional()
  metadata?: { phone_number_id?: string };
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
  @IsString()
  field?: string;
  @IsOptional()
  @ValidateNested()
  @Type(() => WhatsAppChangeValueDto)
  value?: WhatsAppChangeValueDto;
}

export class WhatsAppEntryDto {
  @IsOptional()
  time?: number;
  @IsOptional()
  @IsString()
  id?: string;
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
