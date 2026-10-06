import { Type } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import {
  TEMPLATE_LANGUAGES,
  TEMPLATE_PURPOSES,
} from '../../../shared/messaging/template-registry.types';
import type {
  TemplateLanguage,
  TemplateParameterFormat,
  TemplatePurpose,
} from '../../../shared/messaging/template-registry.types';
import {
  TrimOptionalString,
  TrimString,
} from '../../../shared/validation/trim.transform';

/**
 * These DTOs only bound what is stored. The template rules themselves (name,
 * lengths, variables, buttons) are checked by the draft validation, which
 * answers with a finding per field instead of a 400, so a draft can be saved
 * while it is still being written.
 */
const BODY_STORE_LIMIT = 4096;
const LABEL_STORE_LIMIT = 200;
const SAMPLE_STORE_LIMIT = 200;

export class AdminTemplateSamplesDto {
  @IsOptional()
  @TrimString()
  @IsString()
  @MaxLength(SAMPLE_STORE_LIMIT)
  customer?: string;

  @IsOptional()
  @TrimString()
  @IsString()
  @MaxLength(SAMPLE_STORE_LIMIT)
  store?: string;

  @IsOptional()
  @TrimString()
  @IsString()
  @MaxLength(SAMPLE_STORE_LIMIT)
  order?: string;

  @IsOptional()
  @TrimString()
  @IsString()
  @MaxLength(SAMPLE_STORE_LIMIT)
  total?: string;
}

/** The text of a template: what an edit can change. */
export class AdminTemplateTextDto {
  @TrimString()
  @IsString()
  @MaxLength(BODY_STORE_LIMIT)
  body!: string;

  @TrimString()
  @IsString()
  @MaxLength(LABEL_STORE_LIMIT)
  confirm_label!: string;

  @TrimString()
  @IsString()
  @MaxLength(LABEL_STORE_LIMIT)
  cancel_label!: string;

  @ValidateNested()
  @Type(() => AdminTemplateSamplesDto)
  samples!: AdminTemplateSamplesDto;
}

export class AdminTemplateDraftDto extends AdminTemplateTextDto {
  @IsIn([...TEMPLATE_PURPOSES])
  purpose!: TemplatePurpose;

  @IsIn([...TEMPLATE_LANGUAGES])
  language!: TemplateLanguage;

  @TrimString()
  @IsString()
  @MaxLength(64)
  style!: string;

  @TrimString()
  @IsString()
  @MaxLength(16)
  language_code!: string;

  @IsIn(['named', 'positional'])
  parameter_format!: TemplateParameterFormat;
}

/** A draft to check without saving it. `draft_id` checks a saved draft. */
export class AdminTemplateDraftValidateDto extends AdminTemplateDraftDto {
  @IsOptional()
  @IsUUID()
  draft_id?: string;
}

/** Purpose, language and style are fixed once a draft exists. */
export class AdminTemplateDraftUpdateDto extends AdminTemplateTextDto {
  @TrimString()
  @IsString()
  @MaxLength(16)
  language_code!: string;

  @IsIn(['named', 'positional'])
  parameter_format!: TemplateParameterFormat;
}

export class AdminTemplateReplacementDto {
  /** The registry key of the template that takes over, when one is needed. */
  @IsOptional()
  @TrimOptionalString()
  @IsString()
  @Matches(/^[a-z0-9_]{1,40}(\.[a-z0-9_]{1,40}){2}$/)
  replacement_key?: string;
}
