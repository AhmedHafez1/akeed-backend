import { IsBoolean, IsIn, IsString, Matches, MaxLength } from 'class-validator';
import {
  MESSAGE_TEXT_MAX_LENGTH,
  MESSAGE_TEXT_PURPOSES,
  MESSAGE_TEXT_STYLE_PATTERN,
  type MessageTextPurpose,
} from '../../../shared/messaging/message-texts.types';
import {
  TEMPLATE_LANGUAGES,
  type TemplateLanguage,
} from '../../../shared/messaging/template-registry.types';
import { TrimString } from '../../../shared/validation/trim.transform';

/**
 * One free-form text (US-08-07). These DTOs bound what is stored; the
 * placeholder rules per purpose are checked in the service.
 */
export class AdminMessageTextDto {
  @IsIn([...MESSAGE_TEXT_PURPOSES])
  purpose!: MessageTextPurpose;

  @IsIn([...TEMPLATE_LANGUAGES])
  language!: TemplateLanguage;

  @TrimString()
  @IsString()
  @Matches(MESSAGE_TEXT_STYLE_PATTERN)
  style!: string;

  @TrimString()
  @IsString()
  @MaxLength(MESSAGE_TEXT_MAX_LENGTH)
  body!: string;

  @IsBoolean()
  is_active!: boolean;
}
