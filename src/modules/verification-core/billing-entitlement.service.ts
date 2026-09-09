import { UsageAccountingRouter } from '../../infrastructure/database/repositories/usage-accounting.router';
import { Injectable } from '@nestjs/common';
import { IntegrationMonthlyUsageRepository } from '../../infrastructure/database/repositories/integration-monthly-usage.repository';
import {
  resolveEntitlement,
  type EntitlementIdentity,
  type EntitlementSource,
  type EntitlementAvailability,
} from '../../shared/billing/entitlement';
import { getBillingPeriodStart } from '../../shared/billing/billing-period';

@Injectable()
export class BillingEntitlementService {
  constructor(
    private readonly monthlyUsageRepository: IntegrationMonthlyUsageRepository,
    private readonly accounting?: UsageAccountingRouter,
  ) {}

  evaluateAccess(
    source: EntitlementSource,
    identity: EntitlementIdentity = source,
  ) {
    return resolveEntitlement(source, identity);
  }

  async readEntitlement(identity: EntitlementIdentity) {
    const source =
      await this.monthlyUsageRepository.getEntitlementSource(identity);
    const entitlement = resolveEntitlement(source, identity);
    const accounting = this.accounting;
    if (
      source &&
      accounting &&
      accounting.mode(source.platformType) === 'prepaid_credit'
    ) {
      const availability = await accounting.readAvailability(source.orgId);
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
      : { consumedCount: 0 };
    return { ...entitlement, consumedCount: usage.consumedCount };
  }

  async hasAvailableSlot(
    identity: EntitlementIdentity,
  ): Promise<EntitlementAvailability> {
    const source =
      await this.monthlyUsageRepository.getEntitlementSource(identity);
    const access = resolveEntitlement(source, identity);
    const accounting = this.accounting;
    if (
      source &&
      accounting &&
      accounting.mode(source.platformType) === 'prepaid_credit'
    ) {
      if (!access.allowed)
        return {
          available: false,
          reason: access.reason,
          consumedCount: 0,
          includedLimit: 0,
        };
      return accounting.readAvailability(source.orgId);
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
}
