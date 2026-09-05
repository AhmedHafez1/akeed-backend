import {
  IsIn,
  IsNotEmpty,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export class MessageDispatchResolutionDto {
  @IsIn(['accepted', 'not_accepted'])
  resolution!: 'accepted' | 'not_accepted';

  @ValidateIf(
    (value: MessageDispatchResolutionDto) => value.resolution === 'accepted',
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  providerMessageId?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason!: string;
}
