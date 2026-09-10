import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  NotEquals,
  ValidateIf,
} from 'class-validator';
import {
  TrimOptionalString,
  TrimString,
} from '../../../shared/validation/trim.transform';
import type { StaffEvidenceAction } from '../../billing/payment-callback.service';
import { MAX_ADJUSTMENT_CREDITS } from '../standalone-billing-operations.types';

const FINGERPRINT = /^[a-f0-9]{64}$/;
/** Provider message, refund and dispute ids: printable, no whitespace. */
const PROVIDER_IDENTIFIER = /^[A-Za-z0-9._:\-=+/]+$/;
const MAX_DATABASE_INTEGER = 2147483647;

export const STAFF_EVIDENCE_ACTIONS = [
  'refund',
  'chargeback_open',
  'chargeback_lost',
  'chargeback_won',
] as const satisfies readonly StaffEvidenceAction[];

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

/** Carries no balance: the repair recounts its sources under lock. */
export class RepairApplyDto extends ReasonDto {
  @IsUUID() previewId!: string;
  @Matches(FINGERPRINT) fingerprint!: string;
}

/**
 * Every operation on a dispatch or a purchase names the organization it is
 * performed for, so the service can refuse an identifier from another tenant.
 */
class TenantScopedDto extends ReasonDto {
  @IsUUID() orgId!: string;
}

export class DispatchResolveDto extends TenantScopedDto {
  @IsIn(['accepted', 'not_accepted'])
  resolution!: 'accepted' | 'not_accepted';

  /** Required to call a send accepted: the provider's own message id. */
  @ValidateIf((body: DispatchResolveDto) => body.resolution === 'accepted')
  @TrimString()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Matches(PROVIDER_IDENTIFIER)
  providerMessageId?: string;

  @IsOptional()
  @TrimOptionalString()
  @IsString()
  @MaxLength(500)
  evidence?: string;
}

export class PurchaseReconcileDto extends TenantScopedDto {}

/**
 * Evidence, not authority. There is no status field: `success` is not an
 * action, and every amount is checked against the stored purchase.
 */
export class ProviderActionDto extends TenantScopedDto {
  @IsIn(STAFF_EVIDENCE_ACTIONS)
  action!: StaffEvidenceAction;

  /** The provider refund or dispute id. A missing one is quarantined. */
  @IsOptional()
  @TrimOptionalString()
  @IsString()
  @MaxLength(128)
  @Matches(PROVIDER_IDENTIFIER)
  providerReference?: string;

  /**
   * For a refund, the cumulative amount the provider reports as refunded;
   * for a dispute, the disputed amount. In minor units.
   */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_DATABASE_INTEGER)
  amountMinor!: number;

  @Matches(/^[A-Z]{3}$/)
  currency!: string;

  @TrimString()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  evidence!: string;
}
