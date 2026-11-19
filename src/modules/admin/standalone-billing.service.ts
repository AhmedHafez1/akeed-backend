import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readStandaloneCreditBillingConfig } from '../../shared/config/standalone-credit-billing.config';
import {
  isStandaloneBillingOperator,
  readStandaloneBillingOperationsConfig,
} from '../../shared/config/standalone-billing-operations.config';
import type { AccountFilters } from './standalone-billing-operations.types';
import {
  StandaloneBillingRepository,
  type CheckoutAttemptQueryRow,
} from './standalone-billing.repository';
import {
  checkoutOutcome,
  type CheckoutPaidFilter,
} from './checkout-attempts.policy';
import type { CheckoutAttemptRow } from './standalone-billing.types';

@Injectable()
export class StandaloneBillingService {
  constructor(
    private readonly repository: StandaloneBillingRepository,
    private readonly config: ConfigService,
  ) {}

  async list(
    userId: string,
    query: AccountFilters & { limit?: number; cursor?: string } = {},
  ) {
    const limit = query.limit ?? 50;
    const { lowBalanceThreshold } = readStandaloneCreditBillingConfig(
      this.config,
    );
    const organizations = await this.repository.listOrganizationIds(
      limit,
      query.cursor,
      {
        accountStatus: query.accountStatus,
        balance: query.balance,
        reconciliation: query.reconciliation,
      },
      lowBalanceThreshold,
    );
    const page = organizations.slice(0, limit);
    const rows = await this.repository.loadAccountRows(
      page.map(({ id }) => id),
      lowBalanceThreshold,
    );
    const operations = readStandaloneBillingOperationsConfig(this.config);
    return {
      rows,
      nextCursor:
        organizations.length > limit ? (page.at(-1)?.id ?? null) : null,
      lowBalanceThreshold,
      operations: {
        enabled: operations.enabled,
        operator: isStandaloneBillingOperator(operations, userId),
      },
    };
  }

  /**
   * Merchants who started a checkout, for staff to follow up. Only checkouts in
   * the deployment's payment mode count: live in production.
   */
  async checkoutAttempts(
    query: { limit?: number; offset?: number; paid?: CheckoutPaidFilter } = {},
    now: number = Date.now(),
  ): Promise<{ rows: CheckoutAttemptRow[]; nextOffset: number | null }> {
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    const billing = readStandaloneCreditBillingConfig(this.config);
    const found = await this.repository.listCheckoutAttempts(
      limit,
      offset,
      query.paid ?? 'all',
      billing.enabled ? billing.paymob.mode : 'live',
    );
    return {
      rows: found.slice(0, limit).map((row) => toCheckoutAttemptRow(row, now)),
      nextOffset: found.length > limit ? offset + limit : null,
    };
  }
}

function iso(value: string | Date): string;
function iso(value: string | Date | null): string | null;
function iso(value: string | Date | null): string | null {
  if (value === null) return null;
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function toCheckoutAttemptRow(
  row: CheckoutAttemptQueryRow,
  now: number,
): CheckoutAttemptRow {
  return {
    orgId: row.org_id,
    organizationName: row.organization_name,
    owner: {
      name: row.owner_name,
      email: row.owner_email,
      whatsappPhone: row.merchant_whatsapp_phone,
    },
    source:
      row.platform_type && row.platform_store_url
        ? { platformType: row.platform_type, identity: row.platform_store_url }
        : null,
    attempts: Number(row.attempts),
    firstAttemptAt: iso(row.first_attempt_at),
    lastAttemptAt: iso(row.last_attempt_at),
    paidEver: row.paid_ever,
    latest: {
      reference: row.reference,
      status: row.status,
      outcome: checkoutOutcome(
        {
          status: row.status,
          declineCode: row.decline_code,
          checkoutExpiresAt: iso(row.checkout_expires_at),
        },
        now,
      ),
      declineCode: row.decline_code,
      reconciliationCode: row.reconciliation_code,
      totalMinor: Number(row.total_minor),
      currency: row.currency,
    },
  };
}
