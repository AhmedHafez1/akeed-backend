import { ConflictException } from '@nestjs/common';
import { isCreditDenialCode } from '../../shared/billing/credit-eligibility';
import type { SendReadinessBlocker } from './standalone-send-readiness.types';
import { MANUAL_ORDER_SOURCE_CODES } from './standalone-source-resolver';

interface DenialCopy {
  code: string;
  message: string;
}

/**
 * The codes and messages one channel answers with when its source cannot send
 * a new order right now. Like `StandaloneSourceCodeMap`, only the vocabulary
 * is per-channel: the rules live in `StandaloneSendReadinessService` and the
 * precedence in `assertSendReady`. Credit denials are not listed because every
 * channel answers them with the E04.5 code unchanged.
 */
export interface StandaloneReadinessCodeMap {
  /** The source has no active entitlement. */
  entitlementRequired: DenialCopy;
  /** Automatic verification is switched off. */
  autoVerifyDisabled: DenialCopy;
  /** The plan's included verifications for the period are used up. */
  planLimitReached: DenialCopy;
  /** Any other blocker: the source is not ready, so nothing is accepted. */
  setupIncomplete: DenialCopy;
}

export const MANUAL_ORDER_READINESS_CODES: StandaloneReadinessCodeMap = {
  entitlementRequired: {
    code: 'MANUAL_ORDER_ENTITLEMENT_REQUIRED',
    message: 'An active Standalone entitlement is required.',
  },
  autoVerifyDisabled: {
    code: 'MANUAL_ORDER_AUTO_VERIFY_DISABLED',
    message: 'Enable automatic verification before creating an order.',
  },
  planLimitReached: {
    code: 'MANUAL_ORDER_PLAN_LIMIT_REACHED',
    message: 'The included verifications for this period are used up.',
  },
  setupIncomplete: MANUAL_ORDER_SOURCE_CODES.setupIncomplete,
};

/** The first readiness blocker of `kind`, typed. */
export function blockerOf<K extends SendReadinessBlocker['kind']>(
  blockers: SendReadinessBlocker[],
  kind: K,
): Extract<SendReadinessBlocker, { kind: K }> | undefined {
  return blockers.find(
    (blocker): blocker is Extract<SendReadinessBlocker, { kind: K }> =>
      blocker.kind === kind,
  );
}

/**
 * Refuses a new order while its source cannot send, in the channel's own
 * vocabulary. Every channel that submits one order goes through this, so the
 * precedence is decided once: entitlement, automatic verification, credit,
 * slot, then fail closed.
 *
 * Read-only order and verification access stays open while credit is
 * unavailable; only the billable actions are refused.
 */
export function assertSendReady(
  blockers: SendReadinessBlocker[],
  codes: StandaloneReadinessCodeMap,
): void {
  if (blockers.length === 0) return;
  const entitlement = blockerOf(blockers, 'entitlement_required');
  if (entitlement) {
    throw new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      message: codes.entitlementRequired.message,
      code: codes.entitlementRequired.code,
      reason: entitlement.reason,
    });
  }
  if (blockerOf(blockers, 'auto_verify_disabled')) {
    throw new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      message: codes.autoVerifyDisabled.message,
      code: codes.autoVerifyDisabled.code,
    });
  }
  const credit = blockerOf(blockers, 'credit_denied');
  if (credit) {
    throw new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      message: 'Credit is not available for this action.',
      code: credit.code,
      reason: credit.code,
    });
  }
  // The entitlement policy never reads usage, so a source at its included
  // limit passes it; without this the create answered 202 and the worker
  // silently skipped the verification. Advisory by design: the dispatch
  // claim is what actually reserves the slot.
  const slot = blockerOf(blockers, 'slot_unavailable');
  if (slot) {
    const limitReached = slot.reason === 'plan_limit_reached';
    throw new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      message: limitReached
        ? codes.planLimitReached.message
        : codes.entitlementRequired.message,
      code: isCreditDenialCode(slot.reason)
        ? slot.reason
        : limitReached
          ? codes.planLimitReached.code
          : codes.entitlementRequired.code,
      reason: slot.reason,
      consumedCount: slot.consumedCount,
      includedLimit: slot.includedLimit,
    });
  }
  // The source resolver already refused inactive and unfinished sources;
  // failing closed here keeps any future blocker from being accepted.
  throw new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    message: codes.setupIncomplete.message,
    code: codes.setupIncomplete.code,
  });
}
