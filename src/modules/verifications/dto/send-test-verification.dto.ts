import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

export class SendTestVerificationDto {
  @IsString()
  @IsNotEmpty({ message: 'customerPhone is required.' })
  @Transform(({ value }: { value: string }) => value.trim())
  @MinLength(7, {
    message:
      'customerPhone must be a valid phone number (example: +201234567890).',
  })
  @MaxLength(20, {
    message:
      'customerPhone must be a valid phone number (example: +201234567890).',
  })
  customerPhone!: string;
}
