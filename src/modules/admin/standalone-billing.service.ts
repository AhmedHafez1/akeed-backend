import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readStandaloneCreditBillingConfig } from '../../shared/config/standalone-credit-billing.config';
import { buildBackendLog } from '../../shared/logging/backend-log.util';
import {
  countApprovalRows,
  evaluateStandaloneApproval,
} from './standalone-billing.policy';
import {
  databaseErrorCode,
  StandaloneBillingRepository,
} from './standalone-billing.repository';
import type {
  ApprovalApplyResult,
  ApprovalRow,
  ApprovalStatus,
} from './standalone-billing.types';

@Injectable()
export class StandaloneBillingService {
  private readonly logger = new Logger(StandaloneBillingService.name);
  constructor(
    private readonly repository: StandaloneBillingRepository,
    private readonly config: ConfigService,
  ) {}

  private approvalEnabled(): boolean {
    return (
      this.config.get<string>('STANDALONE_CREDIT_APPROVAL_ENABLED') === 'true'
    );
  }

  private freeGrantQuantity(): number {
    return readStandaloneCreditBillingConfig(this.config).freeGrant;
  }

  async list(limit = 50, cursor?: string, approval?: ApprovalStatus) {
    const organizations = await this.repository.listOrganizationIds(
      limit,
      cursor,
    );
    const page = organizations.slice(0, limit);
    const freeGrant = this.freeGrantQuantity();
    const rows = (
      await this.repository.loadSnapshots(page.map(({ id }) => id))
    ).map((snapshot) => evaluateStandaloneApproval(snapshot, freeGrant).row);
    return {
      // The cursor walks organizations, so a filtered page can be shorter than
      // `limit` while more matches still follow.
      rows: approval ? rows.filter((row) => row.status === approval) : rows,
      counts: countApprovalRows(rows),
      nextCursor:
        organizations.length > limit ? (page.at(-1)?.id ?? null) : null,
      approvalEnabled: this.approvalEnabled(),
    };
  }

  async preview(userId: string, organizationIds: string[]) {
    const freeGrant = this.freeGrantQuantity();
    const evaluations = (
      await this.repository.loadSnapshots(organizationIds)
    ).map((snapshot) => evaluateStandaloneApproval(snapshot, freeGrant));
    const previewId = await this.repository.savePreview(userId, evaluations);
    const rows: ApprovalRow[] = evaluations.map(({ row }) => row);
    return {
      previewId,
      evaluatedAt: new Date().toISOString(),
      rows,
      counts: countApprovalRows(rows),
      approvalEnabled: this.approvalEnabled(),
    };
  }

  async apply(userId: string, previewId: string, reason: string) {
    if (!this.approvalEnabled())
      throw new ForbiddenException({
        code: 'STANDALONE_APPROVAL_DISABLED',
        message: 'Standalone credit approval is disabled',
      });
    const freeGrant = this.freeGrantQuantity();
    const entries = await this.repository.readPreview(previewId, userId);
    const results: ApprovalApplyResult[] = [];
    for (const entry of entries) {
      try {
        results.push(
          await this.repository.approveOrganization(
            entry,
            userId,
            previewId,
            reason,
            freeGrant,
          ),
        );
      } catch (error) {
        this.logger.error(
          buildBackendLog(StandaloneBillingService.name, {
            action: 'standalone-billing-approve',
            outcome: 'failure',
            userId,
            orgId: entry.orgId,
            previewId,
            errorCode: databaseErrorCode(error),
            errorName: error instanceof Error ? error.name : 'UnknownError',
          }),
        );
        results.push({
          orgId: entry.orgId,
          outcome: 'failed',
          reason: 'approval_failed',
        });
      }
    }
    return { previewId, completedAt: new Date().toISOString(), results };
  }
}
