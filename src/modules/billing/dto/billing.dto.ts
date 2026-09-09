import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import type {
  DisputeStatus,
  PurchaseStatus,
} from '../../../shared/ports/payments.port';
import type { CreditLedgerType } from '../../../shared/ports/credit-accounting.port';
import { PURCHASE_REFERENCE_PATTERN } from '../billing.policy';
import type { PurchaseDenialCode } from '../billing.policy';

const LEDGER_TYPES: CreditLedgerType[] = [
  'free_grant',
  'purchase',
  'consumption',
  'failure_reversal',
  'refund_reversal',
  'chargeback_reversal',
  'chargeback_reinstatement',
  'staff_adjustment',
];

export class PageQueryDto {
  @IsOptional() @IsString() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

export class LedgerQueryDto extends PageQueryDto {
  @IsOptional() @IsIn(LEDGER_TYPES) type?: CreditLedgerType;
}

export class PurchaseRefParamDto {
  @Matches(PURCHASE_REFERENCE_PATTERN, {
    message: 'purchaseRef is not a valid purchase reference.',
  })
  purchaseRef!: string;
}

/**
 * Quantity is the only merchant input. Price, currency, organization and actor
 * are all derived server-side, and the controller's pipe rejects any other
 * property outright rather than silently stripping it.
 */
export class CreatePurchaseDto {
  @Type(() => Number) @IsInt() quantity!: number;
}

export interface CreditSummaryResponseDto {
  status: 'pending_approval' | 'active' | 'suspended' | 'not_provisioned';
  postedBalance: number;
  heldCredits: number;
  availableCredits: number;
  debtCredits: number;
  lowBalanceThreshold: number;
  freeGrant: { granted: boolean; quantity: number; grantedAt: string | null };
  price: { unitPriceMinor: number; currency: string };
  range: { min: number; max: number; step: number };
  canPurchase: boolean;
  purchaseDenialReason: PurchaseDenialCode | null;
}

export interface LedgerEntryDto {
  id: string;
  type: CreditLedgerType;
  quantity: number;
  reason: string;
  postedBalanceAfter: number;
  createdAt: string;
  purchaseRef: string | null;
}

export interface PurchaseSummaryDto {
  reference: string;
  status: PurchaseStatus;
  disputeStatus: DisputeStatus;
  quantity: number;
  unitPriceMinor: number;
  totalMinor: number;
  currency: string;
  refundedMinor: number;
  checkoutExpiresAt: string | null;
  createdAt: string;
}

export interface PurchaseDetailDto extends PurchaseSummaryDto {
  reconciliationRequired: boolean;
}

export interface CreatePurchaseResponseDto extends PurchaseSummaryDto {
  /**
   * Present exactly once, on the response that created the intention.
   *
   * The URL embeds the provider client secret, so it is never stored and never
   * re-issued; an idempotent replay answers `null` with
   * `CHECKOUT_URL_ALREADY_ISSUED`.
   */
  checkoutUrl: string | null;
  duplicate: boolean;
  code?: string;
}

export interface PagedResponseDto<T> {
  items: T[];
  nextCursor: string | null;
  limit: number;
}
