import { IsBoolean } from 'class-validator';

export class UpdateWhatsappConnectionSettingsDto {
  @IsBoolean()
  thankYouEnabled!: boolean;
}

export interface WhatsappConnectionSettingsDto {
  thankYouEnabled: boolean;
}
