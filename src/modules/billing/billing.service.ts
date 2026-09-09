import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import { readStandaloneCreditBillingConfig } from '../../shared/config/standalone-credit-billing.config';
import { resolveFallbackActiveIntegration } from '../../shared/commerce/current-integration-resolver';
import { IntegrationsRepository } from '../../infrastructure/database/repositories/integrations.repository';
import { CreditAccountingRepository } from '../../infrastructure/database/repositories/credit-accounting.repository';
import {
  PaymentRequestConflictError,
  PaymentPurchasesRepository,
} from '../../infrastructure/database/repositories/payment-purchases.repository';
import {
  DRIZZLE,
  type DrizzleDB,
} from '../../infrastructure/database/database.provider';
import type { CreditTransaction } from '../../infrastructure/database/credit-transaction';
import {
  PAYMENTS_PORT,
  type PaymentsPort,
} from '../../shared/ports/payments.port';
import {
  buildPurchaseReference,
  buildRequestHash,
  decodeCursor,
  normalizeIdempotencyKey,
  paginate,
  priceQuantity,
  purchaseDenial,
  PurchaseQuantityError,
  type PricedPurchase,
} from './billing.policy';
import {
  BILLING_ERROR_CODES,
  PAYMENT_PROVIDER_PAYMOB,
  type PurchasePricing,
} from './billing.types';
import { BillingRepository } from './billing.repository';
import { PaymentReconciliationService } from './payment-reconciliation.service';
import type {
  CreatePurchaseResponseDto,
  CreditSummaryResponseDto,
  LedgerEntryDto,
  PagedResponseDto,
  PurchaseDetailDto,
  PurchaseSummaryDto,
} from './dto/billing.dto';
import type { LedgerQueryDto, PageQueryDto } from './dto/billing.dto';

const DEFAULT_PAGE = 25;

/**
 * Merchant-facing billing.
 *
 * Two rules shape everything here. The organization, the actor's role, the
 * price and the currency are all derived from the authenticated principal and
 * server configuration -- the request contributes a quantity and nothing else.
 * And the local purchase row is committed *before* the provider is called, so a
 * lost response leaves something to reconcile rather than a charge with no
 * record.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly config: ConfigService,
    private readonly credits: CreditAccountingRepository,
    private readonly purchases: PaymentPurchasesRepository,
    private readonly billing: BillingRepository,
    private readonly integrations: IntegrationsRepository,
    private readonly reconciliation: PaymentReconciliationService,
    @Inject(PAYMENTS_PORT) private readonly payments: PaymentsPort,
  ) {}

  private transaction<T>(
    work: (tx: CreditTransaction) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(work);
  }

  private pricing(): PurchasePricing & { enabled: boolean; freeGrant: number } {
    const billing = readStandaloneCreditBillingConfig(this.config);
    return { ...billing, enabled: billing.enabled };
  }

  private mode() {
    const billing = readStandaloneCreditBillingConfig(this.config);
    return billing.enabled ? billing.paymob.mode : 'test';
  }

  /**
   * The active commerce source, or null.
   *
   * Purchase eligibility depends on it (only Standalone buys credits), and an
   * ambiguous ownership is a staff matter rather than something to guess at.
   */
  private async platformType(orgId: string): Promise<string | null> {
    const resolution = await resolveFallbackActiveIntegration(
      this.integrations,
      orgId,
    );
    if (resolution.outcome === 'ambiguous')
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'Multiple active commerce sources require staff review.',
        code: BILLING_ERROR_CODES.sourceAmbiguous,
      });
    return resolution.outcome === 'found'
      ? resolution.integration.platformType
      : null;
  }

  async readCredits(
    user: AuthenticatedUser,
  ): Promise<CreditSummaryResponseDto> {
    const pricing = this.pricing();
    const [summary, grant, platformType] = await Promise.all([
      this.credits.getSummary(user.orgId),
      this.billing.readFreeGrant(user.orgId),
      this.platformType(user.orgId),
    ]);
    const denial = purchaseDenial({
      enabled: pricing.enabled,
      platformType,
      role: user.role,
      summary,
    });
    return {
      status: summary?.status ?? 'not_provisioned',
      postedBalance: summary?.postedBalance ?? 0,
      heldCredits: summary?.heldCredits ?? 0,
      availableCredits: summary?.availableCredits ?? 0,
      debtCredits: summary?.debtCredits ?? 0,
      lowBalanceThreshold: pricing.lowBalanceThreshold,
      freeGrant: {
        granted: Boolean(grant),
        quantity: grant?.quantity ?? pricing.freeGrant,
        grantedAt: grant?.createdAt ?? null,
      },
      // Always from configuration. A merchant seeing a price they did not get
      // charged is the failure this guarantees against.
      price: { unitPriceMinor: pricing.priceMinor, currency: 'EGP' },
      range: {
        min: pricing.purchaseMin,
        max: pricing.purchaseMax,
        step: pricing.purchaseStep,
      },
      canPurchase: denial === null,
      purchaseDenialReason: denial,
    };
  }

  async listLedger(
    user: AuthenticatedUser,
    query: LedgerQueryDto,
  ): Promise<PagedResponseDto<LedgerEntryDto>> {
    const limit = query.limit ?? DEFAULT_PAGE;
    const rows = await this.billing.listLedger({
      orgId: user.orgId,
      limit,
      cursor: this.cursor(query.cursor),
      type: query.type,
    });
    const page = paginate(rows, limit);
    return { items: page.items, nextCursor: page.nextCursor, limit };
  }

  async listPurchases(
    user: AuthenticatedUser,
    query: PageQueryDto,
  ): Promise<PagedResponseDto<PurchaseSummaryDto>> {
    const limit = query.limit ?? DEFAULT_PAGE;
    const rows = await this.billing.listPurchases({
      orgId: user.orgId,
      limit,
      cursor: this.cursor(query.cursor),
    });
    const page = paginate(rows, limit);
    return {
      // `id` drives the cursor but is an internal key; only the reference is
      // ever a merchant-facing handle on a purchase.
      items: page.items.map((purchase) => this.summarize(purchase)),
      nextCursor: page.nextCursor,
      limit,
    };
  }

  /**
   * Reads one purchase, and takes the chance to recover a stale one.
   *
   * The merchant's own polling is what drives inquiry: a purchase whose
   * checkout window has passed with no callback is asked about here, rate
   * limited by its own `next_reconciliation_at` so repeated polling cannot turn
   * into repeated provider calls. The recovery is best effort -- a provider
   * that is down must not make a merchant's billing page fail.
   */
  async readPurchase(
    user: AuthenticatedUser,
    reference: string,
  ): Promise<PurchaseDetailDto> {
    try {
      await this.reconciliation.reconcile(user.orgId, reference);
    } catch (error) {
      this.logger.warn(
        buildBackendLog(BillingService.name, {
          action: 'billing-purchase-reconcile',
          outcome: 'failure',
          orgId: user.orgId,
          reference,
          ...normalizeError(error),
        }),
      );
    }
    const purchase = await this.purchases.findDetailForOrganization(
      user.orgId,
      reference,
    );
    // A reference belonging to another tenant and one that does not exist
    // answer identically, so this endpoint is not an existence oracle.
    if (!purchase)
      throw new NotFoundException({
        statusCode: 404,
        error: 'Not Found',
        message: 'Purchase not found.',
        code: BILLING_ERROR_CODES.purchaseNotFound,
      });
    // Rebuilt field by field rather than filtered: the row also carries the
    // provider identifiers and the next-inquiry schedule, and a later column
    // must not join the response by default.
    return {
      ...this.summarize(purchase),
      reconciliationRequired: purchase.reconciliationRequired,
    };
  }

  /**
   * Starts a checkout.
   *
   * The local purchase is committed on its own before the provider call. That
   * ordering is what makes a lost response recoverable: the reference exists,
   * so it can be inquired, and the same idempotency key can never produce a
   * second intention.
   */
  async createPurchase(
    user: AuthenticatedUser,
    idempotencyKey: string | undefined,
    quantity: number,
  ): Promise<CreatePurchaseResponseDto> {
    const pricing = this.pricing();
    const [summary, platformType] = await Promise.all([
      this.credits.getSummary(user.orgId),
      this.platformType(user.orgId),
    ]);
    const denial = purchaseDenial({
      enabled: pricing.enabled,
      platformType,
      role: user.role,
      summary,
    });
    if (denial)
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        message: 'This account cannot start a credit purchase.',
        code: denial,
      });

    let priced: PricedPurchase;
    let requestKey: string;
    try {
      requestKey = normalizeIdempotencyKey(idempotencyKey);
      priced = priceQuantity(quantity, pricing);
    } catch (error) {
      if (!(error instanceof PurchaseQuantityError)) throw error;
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: error.detail,
        code: idempotencyKey
          ? BILLING_ERROR_CODES.validationFailed
          : BILLING_ERROR_CODES.idempotencyKeyRequired,
      });
    }

    const reference = buildPurchaseReference();
    const expiresAt = new Date(
      Date.now() + this.checkoutSeconds() * 1000,
    ).toISOString();

    let created: Awaited<
      ReturnType<PaymentPurchasesRepository['createPending']>
    >;
    try {
      created = await this.transaction((tx) =>
        this.purchases.createPending(tx, {
          orgId: user.orgId,
          reference,
          provider: PAYMENT_PROVIDER_PAYMOB,
          mode: this.mode(),
          requestKey,
          requestHash: buildRequestHash({ orgId: user.orgId, ...priced }),
          quantity: priced.quantity,
          unitPriceMinor: priced.unitPriceMinor,
          totalMinor: priced.totalMinor,
          currency: priced.currency,
          checkoutExpiresAt: expiresAt,
        }),
      );
    } catch (error) {
      if (error instanceof PaymentRequestConflictError)
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          message:
            'Idempotency-Key was already used with a different quantity.',
          code: BILLING_ERROR_CODES.idempotencyConflict,
        });
      throw error;
    }

    const purchase = created.purchase;
    if (created.duplicate) {
      // The intention already exists, and its client secret was deliberately
      // never stored. Re-issuing a checkout URL would mean keeping a live
      // payment credential at rest; a new attempt takes a new key instead.
      return {
        ...this.summarize(purchase),
        checkoutUrl: null,
        duplicate: true,
        code: BILLING_ERROR_CODES.checkoutAlreadyIssued,
      };
    }

    const checkout = await this.payments.createCheckout({
      reference: purchase.reference,
      quantity: purchase.quantity,
      unitPriceMinor: purchase.unitPriceMinor,
      totalMinor: purchase.totalMinor,
      currency: purchase.currency,
      expiresAt: purchase.checkoutExpiresAt ?? expiresAt,
    });

    if (checkout.outcome === 'created') {
      const bound = await this.transaction((tx) =>
        this.purchases.updatePurchase(tx, user.orgId, purchase.id, 'pending', {
          providerIntentionId: checkout.payment.providerIntentionId,
          providerOrderId: checkout.payment.providerOrderId,
          checkoutExpiresAt: checkout.expiresAt,
        }),
      );
      this.logger.log(
        buildBackendLog(BillingService.name, {
          action: 'billing-purchase-created',
          outcome: 'success',
          orgId: user.orgId,
          userId: user.userId,
          reference: purchase.reference,
          quantity: purchase.quantity,
        }),
      );
      return {
        ...this.summarize(bound),
        checkoutUrl: checkout.checkoutUrl,
        duplicate: false,
      };
    }

    return this.reportProviderFailure(
      user,
      purchase,
      checkout.outcome,
      checkout.code,
    );
  }

  /**
   * A definitive rejection fails the purchase now; an unknown outcome leaves it
   * pending for inquiry, because the intention may exist and a second one must
   * never be created for the same money.
   */
  private async reportProviderFailure(
    user: AuthenticatedUser,
    purchase: { id: string; reference: string },
    outcome: 'rejected' | 'unknown',
    code: string,
  ): Promise<never> {
    const rejected = outcome === 'rejected';
    try {
      await this.transaction((tx) =>
        this.purchases.updatePurchase(tx, user.orgId, purchase.id, 'pending', {
          ...(rejected ? { status: 'failed' as const } : {}),
          reconciliationRequired: true,
          reconciliationCode: rejected
            ? 'provider_rejected'
            : 'provider_unavailable',
          nextReconciliationAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      );
    } catch (error) {
      this.logger.error(
        buildBackendLog(BillingService.name, {
          action: 'billing-purchase-provider-failure',
          outcome: 'failure',
          orgId: user.orgId,
          reference: purchase.reference,
          errorCode: code,
          ...normalizeError(error),
        }),
      );
    }
    if (rejected)
      throw new BadGatewayException({
        statusCode: 502,
        error: 'Bad Gateway',
        message: 'The payment provider refused this purchase.',
        code: BILLING_ERROR_CODES.providerRejected,
        reference: purchase.reference,
      });
    // The reference travels with the error on purpose: the purchase exists and
    // may yet succeed, so the caller polls it rather than starting again.
    throw new ServiceUnavailableException({
      statusCode: 503,
      error: 'Service Unavailable',
      message:
        'The payment provider did not respond. The purchase is pending; poll it before retrying.',
      code: BILLING_ERROR_CODES.providerUnavailable,
      reference: purchase.reference,
    });
  }

  private checkoutSeconds(): number {
    const billing = readStandaloneCreditBillingConfig(this.config);
    return billing.enabled ? billing.paymob.checkoutExpirationSeconds : 0;
  }

  private cursor(value: string | undefined) {
    const cursor = decodeCursor(value);
    if (value && !cursor)
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: 'cursor is not a valid page cursor.',
        code: BILLING_ERROR_CODES.cursorInvalid,
      });
    return cursor;
  }

  private summarize(purchase: {
    reference: string;
    status: PurchaseSummaryDto['status'];
    disputeStatus: PurchaseSummaryDto['disputeStatus'];
    quantity: number;
    unitPriceMinor: number;
    totalMinor: number;
    currency: string;
    refundedMinor: number;
    checkoutExpiresAt: string | null;
    createdAt: string;
  }): PurchaseSummaryDto {
    return {
      reference: purchase.reference,
      status: purchase.status,
      disputeStatus: purchase.disputeStatus,
      quantity: purchase.quantity,
      unitPriceMinor: purchase.unitPriceMinor,
      totalMinor: purchase.totalMinor,
      currency: purchase.currency,
      refundedMinor: purchase.refundedMinor,
      checkoutExpiresAt: purchase.checkoutExpiresAt,
      createdAt: purchase.createdAt,
    };
  }
}
