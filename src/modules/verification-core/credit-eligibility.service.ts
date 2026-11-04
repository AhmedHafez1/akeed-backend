import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SENDER_RESOLVER_PORT,
  type SenderResolverPort,
} from '../../shared/ports/sender-resolver.port';
import {
  nextSendDisplayedCost,
  storedCreditsForMessages,
} from '../../shared/billing/own-number-billing.policy';
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
    @Optional()
    @Inject(SENDER_RESOLVER_PORT)
    private readonly senders?: SenderResolverPort,
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
    return creditDenial(
      summary,
      nextSendDisplayedCost(await this.predictSender(subject.orgId)),
    );
  }

  /**
   * Stored credits `messages` first sends need from this source. Each is one
   * stored credit from the Akeed number and half of one from the merchant's.
   */
  async storedCreditsFor(
    subject: CreditEligibilitySubject,
    messages: number,
  ): Promise<{
    storedCredits: number;
    /** Set when the sends would go from the merchant's own number. */
    ownNumber?: { spareCredit: number };
  }> {
    if (!usesPrepaidCredits(subject) || !this.isEnforced())
      return { storedCredits: messages };
    const sender = await this.predictSender(subject.orgId);
    if (sender !== 'merchant_own') return { storedCredits: messages };
    const spareCredit =
      (await this.credits.getSummary(subject.orgId))?.spareCredit ?? 0;
    return {
      storedCredits: storedCreditsForMessages(messages, sender, spareCredit),
      ownNumber: { spareCredit },
    };
  }

  /** The next send's likely sender; the Akeed number when unknown. */
  async predictSender(orgId: string) {
    return (await this.senders?.predict?.(orgId)) ?? 'akeed_system';
  }
}
