import { UsageAccountingRouter } from '../../infrastructure/database/repositories/usage-accounting.router';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { IntegrationMonthlyUsageRepository } from '../../infrastructure/database/repositories/integration-monthly-usage.repository';
import {
  resolveEntitlement,
  type EntitlementIdentity,
  type EntitlementSource,
  type EntitlementAvailability,
  type UsageAccountingMode,
} from '../../shared/billing/entitlement';
import { getBillingPeriodStart } from '../../shared/billing/billing-period';
import { ownNumberLimit } from '../../shared/billing/billing-plan';
import {
  nextSendDisplayedCost,
  periodicUsageForNextSend,
} from '../../shared/billing/own-number-billing.policy';
import {
  SENDER_RESOLVER_PORT,
  type SenderResolverPort,
} from '../../shared/ports/sender-resolver.port';

@Injectable()
export class BillingEntitlementService {
  constructor(
    private readonly monthlyUsageRepository: IntegrationMonthlyUsageRepository,
    private readonly accounting?: UsageAccountingRouter,
    @Optional()
    @Inject(SENDER_RESOLVER_PORT)
    private readonly senders?: SenderResolverPort,
  ) {}

  /** The next send's likely sender; the Akeed number when unknown. */
  private async predictSender(orgId: string) {
    return (await this.senders?.predict?.(orgId)) ?? 'akeed_system';
  }

  evaluateAccess(
    source: EntitlementSource,
    identity: EntitlementIdentity = source,
  ) {
    return resolveEntitlement(
      source,
      identity,
      undefined,
      this.accountingMode(source),
    );
  }

  async readEntitlement(identity: EntitlementIdentity) {
    const source =
      await this.monthlyUsageRepository.getEntitlementSource(identity);
    const mode = this.accountingMode(source);
    const entitlement = resolveEntitlement(source, identity, undefined, mode);
    const accounting = this.accounting;
    if (source && accounting && mode === 'prepaid_credit') {
      const availability = await accounting.readAvailability(
        source.orgId,
        nextSendDisplayedCost(await this.predictSender(source.orgId)),
      );
      return {
        ...entitlement,
        planId: null,
        includedLimit: availability.includedLimit,
        consumedCount: availability.consumedCount,
        credits: availability.credits,
        creditDenial: availability.reason,
      };
    }
    const usage = source
      ? await this.monthlyUsageRepository.getIntegrationUsageForPeriod({
          integrationId: identity.id,
          periodStart: entitlement.periodStart,
        })
      : { consumedCount: 0, ownNumberConsumed: 0 };
    // While the next send would go from the merchant's number, both pools
    // count; otherwise only the Akeed pool does, exactly as before.
    const sender = source
      ? await this.predictSender(source.orgId)
      : 'akeed_system';
    if (sender !== 'merchant_own')
      return { ...entitlement, consumedCount: usage.consumedCount };
    const combined = periodicUsageForNextSend(
      {
        akeedUsed: usage.consumedCount,
        akeedLimit: entitlement.includedLimit,
        ownUsed: usage.ownNumberConsumed ?? 0,
        ownLimit: ownNumberLimit(entitlement.includedLimit),
      },
      sender,
    );
    return {
      ...entitlement,
      consumedCount: combined.used,
      includedLimit: combined.limit,
    };
  }

  async hasAvailableSlot(
    identity: EntitlementIdentity,
  ): Promise<EntitlementAvailability> {
    const source =
      await this.monthlyUsageRepository.getEntitlementSource(identity);
    const mode = this.accountingMode(source);
    const access = resolveEntitlement(source, identity, undefined, mode);
    const accounting = this.accounting;
    if (source && accounting && mode === 'prepaid_credit') {
      if (!access.allowed)
        return {
          available: false,
          reason: access.reason,
          consumedCount: 0,
          includedLimit: 0,
        };
      return accounting.readAvailability(
        source.orgId,
        nextSendDisplayedCost(await this.predictSender(source.orgId)),
      );
    }
    const entitlement = await this.readEntitlement(identity);
    const available =
      entitlement.allowed &&
      entitlement.consumedCount < entitlement.includedLimit;
    return {
      available,
      consumedCount: entitlement.consumedCount,
      includedLimit: entitlement.includedLimit,
      reason: entitlement.reason ?? (available ? null : 'plan_limit_reached'),
    };
  }

  /**
   * Reserves monthly plan usage. This is the periodic-plan path, so the
   * repository re-reads the locked source and applies the periodic rule inside
   * its transaction; a caller's earlier `evaluateAccess` result is never
   * trusted for the reservation.
   */
  reserveVerificationSlot(identity: EntitlementIdentity) {
    return this.monthlyUsageRepository.reserveMonthlyVerificationSlot({
      id: identity.id,
      orgId: identity.orgId,
    });
  }

  releaseVerificationSlot(params: {
    integrationId: string;
    periodStart: string;
  }): Promise<void> {
    return this.monthlyUsageRepository.releaseMonthlyVerificationSlot(params);
  }

  getBillingPeriodStart = getBillingPeriodStart;

  /** Which accounting system bills this source's new sends. */
  accountingModeFor(
    source: Pick<EntitlementSource, 'platformType'>,
  ): UsageAccountingMode {
    return this.accountingMode(source);
  }

  private accountingMode(
    source: Pick<EntitlementSource, 'platformType'> | undefined,
  ): UsageAccountingMode {
    return source && this.accounting
      ? this.accounting.mode(source.platformType)
      : 'periodic_plan';
  }
}
