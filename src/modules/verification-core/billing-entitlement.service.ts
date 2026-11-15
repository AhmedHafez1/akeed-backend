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
import { usagePool } from '../../shared/billing/usage-pools';
import {
  nextSendDisplayedCost,
  periodicUsageForNextSend,
} from '../../shared/billing/own-number-billing.policy';
import {
  SENDER_RESOLVER_PORT,
  type ResolvedSender,
  type SenderResolverPort,
} from '../../shared/ports/sender-resolver.port';

type PeriodUsage = Awaited<
  ReturnType<IntegrationMonthlyUsageRepository['getIntegrationUsageForPeriod']>
>;

/**
 * The reads one entitlement evaluation needs, each made at most once. A set
 * belongs to the single request that began it: it travels down that request's
 * call chain and is dropped with the response, never kept on a service, so
 * the next request reads billing state afresh.
 */
export interface EntitlementReads {
  source(): Promise<EntitlementSource | undefined>;
  usage(periodStart: string): Promise<PeriodUsage>;
  sender(orgId: string): Promise<ResolvedSender['kind']>;
}

/** Only what the repository read returns, so a seeded set behaves like a fresh one. */
function toEntitlementSource(row: EntitlementSource): EntitlementSource {
  return {
    id: row.id,
    orgId: row.orgId,
    platformType: row.platformType,
    isActive: row.isActive,
    billingStatus: row.billingStatus,
    billingPlanId: row.billingPlanId,
    billingActivatedAt: row.billingActivatedAt,
    paidThroughAt: row.paidThroughAt ?? null,
  };
}

/** Starts `read` on first use; a failed read is forgotten so it can be retried. */
function once<K, V>(
  cache: Map<K, Promise<V>>,
  key: K,
  read: () => Promise<V>,
): Promise<V> {
  const pending = cache.get(key);
  if (pending) return pending;
  const started = read();
  cache.set(key, started);
  started.catch(() => cache.delete(key));
  return started;
}

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

  /**
   * Begins one set of memoized reads for `identity`. `seed` is a row the
   * caller has just loaded for the same integration; it stands in for the
   * source read only when its `id` and `orgId` both match, so a caller can
   * never evaluate one integration against another's billing state.
   */
  beginReads(
    identity: EntitlementIdentity,
    seed?: EntitlementSource,
  ): EntitlementReads {
    const sources = new Map<'source', Promise<EntitlementSource | undefined>>();
    if (seed && seed.id === identity.id && seed.orgId === identity.orgId)
      sources.set('source', Promise.resolve(toEntitlementSource(seed)));
    const usage = new Map<string, Promise<PeriodUsage>>();
    const senders = new Map<string, Promise<ResolvedSender['kind']>>();
    return {
      source: () =>
        once(sources, 'source', () =>
          this.monthlyUsageRepository.getEntitlementSource(identity),
        ),
      usage: (periodStart) =>
        once(usage, periodStart, () =>
          this.monthlyUsageRepository.getIntegrationUsageForPeriod({
            integrationId: identity.id,
            periodStart,
          }),
        ),
      sender: (orgId) => once(senders, orgId, () => this.predictSender(orgId)),
    };
  }

  /** Without `reads`, every call reads fresh billing state. */
  async readEntitlement(
    identity: EntitlementIdentity,
    reads: EntitlementReads = this.beginReads(identity),
  ) {
    const source = await reads.source();
    const mode = this.accountingMode(source);
    const entitlement = resolveEntitlement(source, identity, undefined, mode);
    const accounting = this.accounting;
    if (source && accounting && mode === 'prepaid_credit') {
      const availability = await accounting.readAvailability(
        source.orgId,
        nextSendDisplayedCost(await reads.sender(source.orgId)),
      );
      return {
        ...entitlement,
        planId: null,
        includedLimit: availability.includedLimit,
        consumedCount: availability.consumedCount,
        credits: availability.credits,
        creditDenial: availability.reason,
        pools: null,
      };
    }
    const usage = source
      ? await reads.usage(entitlement.periodStart)
      : { consumedCount: 0, ownNumberConsumed: 0 };
    // While the next send would go from the merchant's number, both pools
    // count; otherwise only the Akeed pool does, exactly as before.
    const sender = source ? await reads.sender(source.orgId) : 'akeed_system';
    const pools = {
      akeed: usagePool(usage.consumedCount, entitlement.includedLimit),
      ownNumber: usagePool(
        usage.ownNumberConsumed ?? 0,
        ownNumberLimit(entitlement.includedLimit),
      ),
    };
    if (sender !== 'merchant_own')
      return { ...entitlement, consumedCount: usage.consumedCount, pools };
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
      pools,
    };
  }

  async hasAvailableSlot(
    identity: EntitlementIdentity,
    reads: EntitlementReads = this.beginReads(identity),
  ): Promise<EntitlementAvailability> {
    const source = await reads.source();
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
        nextSendDisplayedCost(await reads.sender(source.orgId)),
      );
    }
    const entitlement = await this.readEntitlement(identity, reads);
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
