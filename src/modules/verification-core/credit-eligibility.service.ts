import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CreditAccountingRepository } from '../../infrastructure/database/repositories/credit-accounting.repository';
import type { CreditAccountStatus } from '../../shared/ports/credit-accounting.port';
import { readStandaloneCreditBillingConfig } from '../../shared/config/standalone-credit-billing.config';
import {
  creditDenial,
  usesPrepaidCredits,
  type CreditDenialCode,
} from '../../shared/billing/credit-eligibility';

export interface CreditEligibilitySubject {
  orgId: string;
  platformType: string;
}

@Injectable()
export class CreditEligibilityService {
  constructor(
    private readonly credits: CreditAccountingRepository,
    private readonly config: ConfigService,
  ) {}

  isEnforced(): boolean {
    return readStandaloneCreditBillingConfig(this.config).enabled;
  }

  /** `null` when the source is not metered by prepaid credits. */
  async readStatus(
    subject: CreditEligibilitySubject,
  ): Promise<CreditAccountStatus | null> {
    if (!usesPrepaidCredits(subject) || !this.isEnforced()) return null;
    return (await this.credits.getSummary(subject.orgId))?.status ?? null;
  }

  async resolveDenial(
    subject: CreditEligibilitySubject,
  ): Promise<CreditDenialCode | null> {
    if (!usesPrepaidCredits(subject) || !this.isEnforced()) return null;
    const summary = await this.credits.getSummary(subject.orgId);
    if (!summary) return null;
    return creditDenial(summary);
  }
}
