import { Injectable } from '@nestjs/common';
import {
  classifyCodStatus,
  collectPaymentSignals,
} from '../../shared/commerce/payment-signals';
import { BillingEntitlementService } from '../verification-core/billing-entitlement.service';
import { CreditEligibilityService } from '../verification-core/credit-eligibility.service';
import { OrderEligibilityService } from '../verification-core/order-eligibility.service';
import type { StandaloneSource } from './standalone-source-resolver';
import type {
  SendReadiness,
  SendReadinessBlocker,
  SendReadinessOptions,
  SendReadinessOrder,
  SendReadinessSnapshot,
} from './standalone-send-readiness.types';

/**
 * Payment signals captured when the order was ingested.
 *
 * Standalone ingestion stores the canonical order under `rawPayload.order`;
 * reading them back keeps a retry's eligibility decision identical to the
 * original ingestion's, instead of re-deriving it from `paymentMethod` alone.
 */
function readStoredPaymentSignals(rawPayload: unknown): string[] {
  if (!rawPayload || typeof rawPayload !== 'object') return [];
  const order = (rawPayload as Record<string, unknown>).order;
  if (!order || typeof order !== 'object') return [];
  const signals = (order as Record<string, unknown>).paymentSignals;
  if (!Array.isArray(signals)) return [];
  return signals.filter(
    (signal): signal is string => typeof signal === 'string',
  );
}

/**
 * The one answer to "can this Standalone source send N first messages now?".
 *
 * Manual create, manual retry and the bulk-import quote, start, resume and
 * release tick all ask it, so a gate added here applies to every path that can
 * cause a send. It is advisory: the dispatch claim still reserves the credit or
 * slot transactionally. Callers translate the neutral blockers into their own
 * codes and pick their own precedence among them.
 */
@Injectable()
export class StandaloneSendReadinessService {
  constructor(
    private readonly billingEntitlements: BillingEntitlementService,
    private readonly creditEligibility: CreditEligibilityService,
    private readonly orderEligibility: OrderEligibilityService,
  ) {}

  async evaluate(
    source: StandaloneSource,
    options: SendReadinessOptions,
  ): Promise<SendReadiness> {
    const required = Math.max(1, Math.floor(options.required));
    const stopEarly = (options.mode ?? 'first') === 'first';
    const identity = { id: source.id, orgId: source.orgId };
    const snapshot: SendReadinessSnapshot = {
      accountingMode: this.billingEntitlements.accountingModeFor(source),
      creditsAvailable: null,
      slotsRemaining: null,
    };

    // Policy gates: pure reads of the source row, always all evaluated so each
    // caller can apply its own precedence.
    const blockers: SendReadinessBlocker[] = [];
    if (!source.isActive) blockers.push({ kind: 'source_inactive' });
    if (source.onboardingStatus !== 'completed')
      blockers.push({ kind: 'setup_incomplete' });
    const entitlement = this.billingEntitlements.evaluateAccess(
      source,
      identity,
    );
    if (!entitlement.allowed)
      blockers.push({
        kind: 'entitlement_required',
        reason: entitlement.reason,
      });
    if (!source.isAutoVerifyEnabled)
      blockers.push({ kind: 'auto_verify_disabled' });
    // A source that cannot send at all has nothing to say about one order, and
    // the retry path has never evaluated the order in that state.
    const sourceBlocked = blockers.some(
      (blocker) => blocker.kind !== 'entitlement_required',
    );
    if (options.order && !(stopEarly && sourceBlocked)) {
      const reason = this.orderIneligibility(options.order, source);
      if (reason) blockers.push({ kind: 'order_ineligible', reason });
    }
    if (stopEarly && blockers.length > 0)
      return { ready: false, blockers, snapshot };

    // Billing gates: the credit account first, then usage availability.
    const denial = await this.creditEligibility.resolveDenial(source);
    if (denial) {
      blockers.push({
        kind: 'credit_denied',
        code: denial,
        ...(denial === 'INSUFFICIENT_CREDITS' ? { shortfall: required } : {}),
      });
      if (stopEarly) return { ready: false, blockers, snapshot };
    }

    const availability =
      await this.billingEntitlements.hasAvailableSlot(identity);
    if (snapshot.accountingMode === 'prepaid_credit') {
      snapshot.creditsAvailable =
        availability.credits?.availableCredits ?? null;
    } else {
      snapshot.slotsRemaining = Math.max(
        availability.includedLimit - availability.consumedCount,
        0,
      );
    }
    if (!availability.available) {
      blockers.push({
        kind: 'slot_unavailable',
        reason: availability.reason,
        consumedCount: availability.consumedCount,
        includedLimit: availability.includedLimit,
        ...(snapshot.slotsRemaining !== null
          ? { slotsRemaining: snapshot.slotsRemaining }
          : {}),
      });
    } else if (
      snapshot.slotsRemaining !== null &&
      snapshot.slotsRemaining < required
    ) {
      // One slot is left but not `required` of them.
      blockers.push({
        kind: 'slot_unavailable',
        reason: 'plan_limit_reached',
        consumedCount: availability.consumedCount,
        includedLimit: availability.includedLimit,
        slotsRemaining: snapshot.slotsRemaining,
      });
    }

    const available = snapshot.creditsAvailable;
    if (available !== null && available < required) {
      const shortfall = required - Math.max(available, 0);
      const existing = blockers.find(
        (blocker) =>
          blocker.kind === 'credit_denied' &&
          blocker.code === 'INSUFFICIENT_CREDITS',
      );
      if (existing && existing.kind === 'credit_denied') {
        existing.shortfall = shortfall;
        existing.available = available;
      } else if (
        !blockers.some((blocker) => blocker.kind === 'credit_denied')
      ) {
        blockers.push({
          kind: 'credit_denied',
          code: 'INSUFFICIENT_CREDITS',
          shortfall,
          available,
        });
      }
    }

    return { ready: blockers.length === 0, blockers, snapshot };
  }

  private orderIneligibility(
    order: SendReadinessOrder,
    integration: StandaloneSource,
  ): string | null {
    const paymentSignals = collectPaymentSignals(
      readStoredPaymentSignals(order.rawPayload),
      order.paymentMethod ?? undefined,
    );
    const eligibility = this.orderEligibility.evaluateOrderForVerification({
      order: {
        orgId: order.orgId,
        integrationId: order.integrationId,
        externalOrderId: order.externalOrderId,
        orderNumber: order.orderNumber ?? undefined,
        customerPhone: order.customerPhone,
        customerName: order.customerName ?? undefined,
        totalPrice: order.totalPrice ?? '',
        currency: order.currency ?? '',
        paymentMethod: order.paymentMethod ?? '',
        paymentSignals,
        codStatus: classifyCodStatus(paymentSignals),
        rawPayload:
          order.rawPayload && typeof order.rawPayload === 'object'
            ? (order.rawPayload as Record<string, unknown>)
            : {},
      },
      integration,
    });
    return eligibility.eligible ? null : eligibility.reason;
  }
}
