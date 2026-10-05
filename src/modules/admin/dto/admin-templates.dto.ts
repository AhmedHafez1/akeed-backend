import { IsString, Length } from 'class-validator';
import { TrimString } from '../../../shared/validation/trim.transform';

export class AdminTemplateTestSendDto {
  /** A staff phone on the test list, in international format. */
  @TrimString()
  @IsString()
  @Length(8, 32)
  phone!: string;
}
