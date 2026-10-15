import { IsBoolean } from 'class-validator';

export class AdminLogoHeaderDto {
  @IsBoolean()
  enabled!: boolean;
}
