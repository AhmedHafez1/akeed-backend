import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readStandaloneCreditBillingConfig } from '../../shared/config/standalone-credit-billing.config';
import {
  isStandaloneBillingOperator,
  readStandaloneBillingOperationsConfig,
} from '../../shared/config/standalone-billing-operations.config';
import type { AccountFilters } from './standalone-billing-operations.types';
import { StandaloneBillingRepository } from './standalone-billing.repository';

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
}
