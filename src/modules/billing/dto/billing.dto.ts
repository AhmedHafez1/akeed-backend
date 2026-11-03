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
  'own_number_pack',
  'own_number_pack_reversal',
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
 *
 * `displayQuantity` is in displayed credits. `quantity` is what a page loaded
 * before displayed credits still sends, in stored credits; it is accepted here
 * only so that page gets a coded answer telling it to refresh.
 */
export class CreatePurchaseDto {
  @IsOptional() @Type(() => Number) @IsInt() displayQuantity?: number;
  @IsOptional() @Type(() => Number) @IsInt() quantity?: number;
}

export interface CreditSummaryResponseDto {
  billingEnabled: boolean;
  /** Standalone bulk order import is switched on; the UI hides it otherwise. */
  bulkImportEnabled: boolean;
  status: 'active' | 'suspended' | 'not_provisioned';
  postedBalance: number;
  heldCredits: number;
  availableCredits: number;
  debtCredits: number;
  lowBalanceThreshold: number;
  freeGrant: { granted: boolean; quantity: number; grantedAt: string | null };
  price: {
    /** One displayed credit. */
    unitPriceMinor: number;
    /** One Akeed message. */
    messagePriceMinor: number;
    /** Displayed credits one Akeed message uses. */
    creditsPerMessage: number;
    currency: string;
  };
  range: { min: number; max: number; step: number };
  canPurchase: boolean;
  purchaseDenialReason: PurchaseDenialCode | null;
}

export type LedgerActorType = 'akeed_staff' | 'meta' | 'paymob' | 'system';

export type LedgerReasonCode =
  | 'chargeback_reinstated'
  | 'chargeback_reversed'
  | 'delivery_failure_restored'
  | 'launch_grant'
  | 'message_accepted'
  | 'own_number_messages'
  | 'own_number_messages_returned'
  | 'payment_verified'
  | 'refund_reversed'
  | 'staff_adjustment';

export interface LedgerEntryDto {
  id: string;
  type: CreditLedgerType;
  quantity: number;
  actorType: LedgerActorType;
  reasonCode: LedgerReasonCode;
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
  reconciliationRequired: boolean;
  checkoutExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PurchaseDetailDto = PurchaseSummaryDto;

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
