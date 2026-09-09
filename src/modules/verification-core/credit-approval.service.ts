import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CreditAccountingRepository } from '../../infrastructure/database/repositories/credit-accounting.repository';
import type { CreditAccountStatus } from '../../shared/ports/credit-accounting.port';
import { readStandaloneCreditBillingConfig } from '../../shared/config/standalone-credit-billing.config';

/** Wire contract for a denial, fixed by the E04.5 error vocabulary. */
export const CREDIT_APPROVAL_REQUIRED_CODE = 'STANDALONE_APPROVAL_REQUIRED';
export const CREDIT_APPROVAL_REQUIRED_REASON = 'standalone_approval_required';

export interface CreditApprovalSubject {
  orgId: string;
}

/**
 * Answers "may this organization start a billable action yet?".
 *
 * The credit account row is what subscribes an organization to prepaid credit
 * billing, so this stays platform-neutral: an organization without one is
 * governed by its plan entitlement instead and is never blocked here.
 *
 * Until US-04.5-03 moves credit accounting into the dispatch claim this is an
 * advisory check layered on the existing entitlement rules, not the accounting
 * authority, and it is inert while credit billing is disabled.
 */
@Injectable()
export class CreditApprovalService {
  constructor(
    private readonly credits: CreditAccountingRepository,
    private readonly config: ConfigService,
  ) {}

  isEnforced(): boolean {
    return readStandaloneCreditBillingConfig(this.config).enabled;
  }

  /**
   * The account status, or `null` when credit approval does not govern this
   * organization or this deployment.
   */
  async readStatus(
    subject: CreditApprovalSubject,
  ): Promise<CreditAccountStatus | null> {
    if (!this.isEnforced()) return null;
    return (await this.credits.getSummary(subject.orgId))?.status ?? null;
  }

  async isApproved(subject: CreditApprovalSubject): Promise<boolean> {
    const status = await this.readStatus(subject);
    return status === null || status === 'active';
  }

  /** The denial reason, or `null` when the organization may proceed. */
  async resolveDenial(
    subject: CreditApprovalSubject,
  ): Promise<typeof CREDIT_APPROVAL_REQUIRED_REASON | null> {
    return (await this.isApproved(subject))
      ? null
      : CREDIT_APPROVAL_REQUIRED_REASON;
  }
}
