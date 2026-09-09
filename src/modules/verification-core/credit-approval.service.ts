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

export const CREDIT_APPROVAL_REQUIRED_CODE = 'STANDALONE_APPROVAL_REQUIRED';
export const CREDIT_APPROVAL_REQUIRED_REASON = 'STANDALONE_APPROVAL_REQUIRED';

export interface CreditApprovalSubject {
  orgId: string;
  platformType: string;
}

@Injectable()
export class CreditApprovalService {
  constructor(
    private readonly credits: CreditAccountingRepository,
    private readonly config: ConfigService,
  ) {}

  isEnforced(): boolean {
    return readStandaloneCreditBillingConfig(this.config).enabled;
  }

  async readStatus(
    subject: CreditApprovalSubject,
  ): Promise<CreditAccountStatus | null> {
    if (!usesPrepaidCredits(subject) || !this.isEnforced()) return null;
    return (
      (await this.credits.getSummary(subject.orgId))?.status ??
      'pending_approval'
    );
  }

  async isApproved(subject: CreditApprovalSubject): Promise<boolean> {
    const status = await this.readStatus(subject);
    return status === null || status === 'active';
  }

  async resolveDenial(
    subject: CreditApprovalSubject,
  ): Promise<CreditDenialCode | null> {
    if (!usesPrepaidCredits(subject) || !this.isEnforced()) return null;
    const summary = await this.credits.getSummary(subject.orgId);
    if (!summary) return null;
    return creditDenial(summary);
  }
}
