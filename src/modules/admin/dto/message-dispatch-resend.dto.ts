import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class MessageDispatchResendDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason!: string;
}
