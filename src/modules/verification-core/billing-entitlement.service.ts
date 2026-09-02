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
