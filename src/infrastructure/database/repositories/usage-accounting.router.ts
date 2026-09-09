import { PeriodicPlanAccounting } from './periodic-plan-accounting';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, inArray } from 'drizzle-orm';
import type { CreditTransaction } from '../credit-transaction';
import {
  creditAccounts,
  integrations,
  verificationMessageDispatches,
} from '../schema';
import { readStandaloneCreditBillingConfig } from '../../../shared/config/standalone-credit-billing.config';
import {
  creditDenial,
  type CreditDenialCode,
} from '../../../shared/billing/credit-eligibility';
import { PrepaidCreditAccounting } from './prepaid-credit-accounting';

@Injectable()
export class UsageAccountingRouter {
  constructor(
    readonly prepaid: PrepaidCreditAccounting,
    readonly periodic: PeriodicPlanAccounting,
    private readonly config: ConfigService,
  ) {}

  isEnabled(): boolean {
    return readStandaloneCreditBillingConfig(this.config).enabled;
  }

  /**
   * Which accounting system a *new* send is billed through.
   *
   * The feature flag is part of the answer, not a later denial. E04.5 ships
   * dark: with credit billing off, a Standalone source must keep the periodic
   * plan accounting it shipped with in E04, and disabling the flag must restore
   * that rather than block every Standalone send behind a reconciliation code.
   *
   * This decides new work only. Settlement follows the `accounting_mode`
   * persisted on the dispatch, so holds taken before a rollback still consume,
   * release and reverse through credits.
   */
  mode(platformType: string): 'prepaid_credit' | 'periodic_plan' {
    return platformType === 'standalone' && this.isEnabled()
      ? 'prepaid_credit'
      : 'periodic_plan';
  }

  async readAvailability(orgId: string) {
    const summary = await this.prepaid.repository.getSummary(orgId);
    let reason = !readStandaloneCreditBillingConfig(this.config).enabled
      ? ('PAYMENT_PENDING_RECONCILIATION' as const)
      : creditDenial(summary);
    if (!reason) {
      const invariant = await this.prepaid.repository.checkInvariant(orgId);
      if (
        !invariant?.consistent ||
        (await this.prepaid.repository.hasUnresolvedLegacySends(orgId))
      )
        reason = 'PAYMENT_PENDING_RECONCILIATION';
    }
    return {
      available: reason === null,
      reason,
      consumedCount: summary?.heldCredits ?? 0,
      includedLimit: Math.max(summary?.postedBalance ?? 0, 0),
      credits: summary,
    };
  }

  async newHoldDenial(
    tx: CreditTransaction,
    orgId: string,
  ): Promise<CreditDenialCode | null> {
    if (!readStandaloneCreditBillingConfig(this.config).enabled)
      return 'PAYMENT_PENDING_RECONCILIATION';
    const [existing] = await tx
      .select({ orgId: creditAccounts.orgId })
      .from(creditAccounts)
      .where(eq(creditAccounts.orgId, orgId));
    if (!existing) return 'STANDALONE_APPROVAL_REQUIRED';
    const account = await this.prepaid.lock(tx, orgId);
    const denial = creditDenial(this.prepaid.repository.summary(account));
    if (denial) return denial;
    const [legacy] = await tx
      .select({ id: verificationMessageDispatches.id })
      .from(verificationMessageDispatches)
      .innerJoin(
        integrations,
        eq(integrations.id, verificationMessageDispatches.integrationId),
      )
      .where(
        and(
          eq(integrations.platformType, 'standalone'),
          eq(verificationMessageDispatches.orgId, orgId),
          eq(verificationMessageDispatches.accountingMode, 'periodic_plan'),
          inArray(verificationMessageDispatches.state, [
            'sending',
            'outcome_unknown',
          ]),
        ),
      )
      .limit(1);
    return legacy ? 'PAYMENT_PENDING_RECONCILIATION' : null;
  }
}
