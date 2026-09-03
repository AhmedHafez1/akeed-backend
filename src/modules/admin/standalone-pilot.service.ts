import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { buildBackendLog } from '../../shared/logging/backend-log.util';
import {
  countPilotRows,
  evaluateStandalonePilot,
} from './standalone-pilot.policy';
import {
  databaseErrorCode,
  StandalonePilotRepository,
} from './standalone-pilot.repository';
import type { PilotApplyResult } from './standalone-pilot.types';

@Injectable()
export class StandalonePilotService {
  private readonly logger = new Logger(StandalonePilotService.name);
  constructor(
    private readonly repository: StandalonePilotRepository,
    private readonly config: ConfigService,
  ) {}

  private activationEnabled(): boolean {
    return (
      this.config.get<string>('STANDALONE_PILOT_ACTIVATION_ENABLED') === 'true'
    );
  }

  async list(limit = 50, cursor?: string) {
    const organizations = await this.repository.listOrganizationIds(
      limit,
      cursor,
    );
    const page = organizations.slice(0, limit);
    const rows = (
      await this.repository.loadSnapshots(page.map(({ id }) => id))
    ).map((snapshot) => evaluateStandalonePilot(snapshot).row);
    return {
      rows,
      counts: countPilotRows(rows),
      nextCursor:
        organizations.length > limit ? (page.at(-1)?.id ?? null) : null,
      activationEnabled: this.activationEnabled(),
    };
  }

  async preview(userId: string, organizationIds: string[]) {
    const evaluations = (
      await this.repository.loadSnapshots(organizationIds)
    ).map((snapshot) => evaluateStandalonePilot(snapshot));
    const previewId = await this.repository.savePreview(userId, evaluations);
    const rows = evaluations.map(({ row }) => row);
    return {
      previewId,
      evaluatedAt: new Date().toISOString(),
      rows,
      counts: countPilotRows(rows),
      activationEnabled: this.activationEnabled(),
    };
  }

  async apply(userId: string, previewId: string, reason: string) {
    if (!this.activationEnabled())
      throw new ForbiddenException({
        code: 'PILOT_ACTIVATION_DISABLED',
        message: 'Pilot activation is disabled',
      });
    const entries = await this.repository.readPreview(previewId, userId);
    const results: PilotApplyResult[] = [];
    for (const entry of entries) {
      try {
        results.push(
          await this.repository.applyOrganization(
            entry,
            userId,
            previewId,
            reason,
          ),
        );
      } catch (error) {
        this.logger.error(
          buildBackendLog(StandalonePilotService.name, {
            action: 'standalone-pilot-activate',
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
          reason: 'activation_failed',
        });
      }
    }
    return { previewId, completedAt: new Date().toISOString(), results };
  }
}
