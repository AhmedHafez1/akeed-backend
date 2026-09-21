import { isCreditDenialCode } from '../../../shared/billing/credit-eligibility';
import type { SendReadinessBlocker } from '../../order-ingestion/standalone-send-readiness.types';
import type { ImportStartBlockerCode } from '../order-imports.errors';
import { suggestedCreditPurchase } from './release-policy';

/** One reason an import cannot start, resume or keep releasing (AC2). */
export interface ImportStartBlocker {
  code: ImportStartBlockerCode;
  /** The underlying readiness reason, when the code alone is too coarse. */
  reason?: string;
  /** `INSUFFICIENT_CREDITS`: credits missing to cover every held order. */
  shortfall?: number;
  /** `INSUFFICIENT_CREDITS`: what the Buy button proposes. */
  suggestedPurchaseCredits?: number;
  /** `IMPORT_PLAN_LIMIT_REACHED`: plan slots left this period. */
  slotsRemaining?: number;
}

/**
 * The import's vocabulary for the shared readiness blockers.
 *
 * The rules are `StandaloneSendReadinessService`'s; this only names them the
 * way the epic contract does. Credit denials keep their shared codes so the
 * UI reuses its existing `creditErrors.*` copy. Duplicates collapse, so a
 * credit problem reported by both the credit and the usage read appears once.
 */
export function toImportBlockers(
  blockers: SendReadinessBlocker[],
): ImportStartBlocker[] {
  const mapped: ImportStartBlocker[] = [];
  const push = (blocker: ImportStartBlocker) => {
    if (!mapped.some((existing) => existing.code === blocker.code))
      mapped.push(blocker);
  };
  for (const blocker of blockers) {
    switch (blocker.kind) {
      case 'source_inactive':
        push({
          code: 'IMPORT_SETUP_INCOMPLETE',
          reason: 'integration_inactive',
        });
        break;
      case 'setup_incomplete':
        push({
          code: 'IMPORT_SETUP_INCOMPLETE',
          reason: 'onboarding_incomplete',
        });
        break;
      case 'entitlement_required':
        push({
          code: 'IMPORT_SETUP_INCOMPLETE',
          reason: blocker.reason ?? 'entitlement_required',
        });
        break;
      case 'auto_verify_disabled':
        push({ code: 'IMPORT_AUTO_VERIFY_DISABLED' });
        break;
      case 'order_ineligible':
        // Import rows were judged eligible before commit; a source-level
        // check never supplies an order, so this cannot occur here.
        break;
      case 'credit_denied':
        push(
          blocker.code === 'INSUFFICIENT_CREDITS'
            ? {
                code: 'INSUFFICIENT_CREDITS',
                shortfall: blocker.shortfall,
                suggestedPurchaseCredits: suggestedCreditPurchase(
                  blocker.shortfall ?? 1,
                ),
              }
            : { code: blocker.code },
        );
        break;
      case 'slot_unavailable':
        if (blocker.reason === 'plan_limit_reached')
          push({
            code: 'IMPORT_PLAN_LIMIT_REACHED',
            slotsRemaining: blocker.slotsRemaining ?? 0,
          });
        else if (isCreditDenialCode(blocker.reason)) {
          // A usage-side credit denial (e.g. an unreconciled payment) that
          // the credit read did not already report.
          if (!mapped.some((existing) => isCreditDenialCode(existing.code)))
            push({ code: blocker.reason });
        } else
          push({
            code: 'IMPORT_SETUP_INCOMPLETE',
            reason: blocker.reason ?? 'entitlement_required',
          });
        break;
    }
  }
  return mapped;
}
