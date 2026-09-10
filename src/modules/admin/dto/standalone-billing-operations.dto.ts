import { Type } from 'class-transformer';
import {
  IsInt,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  NotEquals,
} from 'class-validator';
import { TrimString } from '../../../shared/validation/trim.transform';
import { MAX_ADJUSTMENT_CREDITS } from '../standalone-billing-operations.types';

const FINGERPRINT = /^[a-f0-9]{64}$/;

/**
 * A staff reason: trimmed, required and bounded. It is stored in the audit
 * row and on the ledger entry, and never logged.
 */
class ReasonDto {
  @TrimString()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

export class AdjustmentPreviewDto {
  @Type(() => Number)
  @IsInt()
  @NotEquals(0)
  @Min(-MAX_ADJUSTMENT_CREDITS)
  @Max(MAX_ADJUSTMENT_CREDITS)
  quantity!: number;
}

/**
 * Deliberately carries no quantity and no balance: both come from the
 * server-stored preview and the locked account.
 */
export class AdjustmentApplyDto extends ReasonDto {
  @IsUUID() previewId!: string;
  @Matches(FINGERPRINT) fingerprint!: string;
}
