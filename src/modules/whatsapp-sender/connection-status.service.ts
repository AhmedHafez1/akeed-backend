import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readWhatsappOwnNumberConfig } from '../../shared/config/whatsapp-own-number.config';
import { resolveSender } from './sender-resolution.policy';
import {
  WhatsappConnectionsRepository,
  type WhatsappConnectionRecord,
} from '../../infrastructure/database/repositories/whatsapp-connections.repository';
import { WhatsappConnectionTemplatesRepository } from '../../infrastructure/database/repositories/whatsapp-connection-templates.repository';
import { WhatsappTemplatesRepository } from '../../infrastructure/database/repositories/whatsapp-templates.repository';
import type {
  WhatsappConnectionStaffViewDto,
  WhatsappConnectionStatusDto,
} from './dto/whatsapp-connection-status.dto';
import { summarizeTemplates } from './template-provisioning.policy';

/**
 * Setup progress and per-template outcomes, built from named fields only: a
 * response never carries a token, PIN, ciphertext, provider message or raw
 * payload. `ready` counts templates approved as UTILITY in the merchant's
 * account. Per-template readiness is a current policy result, separate from
 * the last accepted sender exposed by the availability response.
 */
@Injectable()
export class ConnectionStatusService {
  constructor(
    private readonly connections: WhatsappConnectionsRepository,
    private readonly rows: WhatsappConnectionTemplatesRepository,
    private readonly registry: WhatsappTemplatesRepository,
    @Optional() private readonly config?: ConfigService,
  ) {}

  /** For a member of the organization. Null when it has no connection. */
  async forOrganization(
    orgId: string,
  ): Promise<WhatsappConnectionStatusDto | null> {
    const connection = await this.connections.findByOrg(orgId);
    if (!connection) return null;
    return this.view(connection);
  }

  private async view(
    connection: WhatsappConnectionRecord,
  ): Promise<WhatsappConnectionStatusDto> {
    const orgId = connection.orgId;
    const rows =
      connection.state === 'disconnected'
        ? []
        : await this.rows.listForConnection(orgId, connection.id);
    const [inspected, retired] = await Promise.all([
      this.registry.findAllForInspection(),
      this.registry.findRetiredKeys(),
    ]);
    const enabled = this.config
      ? readWhatsappOwnNumberConfig(this.config).sendingEnabled
      : false;
    const byId = new Map(rows.map((row) => [row.templateId, row]));
    return {
      ...setupView(connection),
      templates: summarizeTemplates(rows),
      templateDetails: inspected
        .filter(
          ({ template }) =>
            template.isActive &&
            template.reviewStatus === 'approved' &&
            !retired.includes(template.key),
        )
        .map(({ id, template }) => {
          const row = byId.get(id);
          const status = row?.status ?? 'missing';
          const category = row?.category ?? null;
          const sender = resolveSender({
            enabled,
            connection,
            template:
              row && row.metaLanguageCode === template.languageCode
                ? { status, category }
                : null,
          });
          return {
            key: template.key,
            language: template.language,
            languageCode: template.languageCode,
            status,
            category,
            readiness: { kind: sender.kind, reason: sender.reason },
          };
        }),
    };
  }

  /** For staff: the same, with each template's outcome. */
  async forStaff(
    orgId: string,
  ): Promise<WhatsappConnectionStaffViewDto | null> {
    const connection = await this.connections.findByOrg(orgId);
    if (!connection) return null;
    const status = await this.view(connection);
    const [rows, inspected] = await Promise.all([
      this.rows.listForConnection(orgId, connection.id),
      this.registry.findAllForInspection(),
    ]);
    const byId = new Map(inspected.map((t) => [t.id, t.template]));
    return {
      ...status,
      wabaId: connection.wabaId,
      phoneNumberId: connection.phoneNumberId,
      providerIsOnBizApp: connection.providerIsOnBizApp,
      providerPlatformType: connection.providerPlatformType,
      setupAttempts: connection.setupAttempts,
      templateRows: rows.map((row) => {
        const template = byId.get(row.templateId);
        return {
          templateKey: template?.key ?? null,
          templateName: template?.templateName ?? null,
          languageCode: row.metaLanguageCode,
          status: row.status,
          category: row.category,
          quality: row.quality,
          rejectionReason: row.rejectionReason,
          metaTemplateId: row.metaTemplateId,
          attempts: row.attempts,
          lastErrorCode: row.lastErrorCode,
          nextAttemptAt: row.nextAttemptAt,
          submittedAt: row.submittedAt,
          lastSyncedAt: row.lastSyncedAt,
          driftAt: row.driftAt,
          driftReason: row.driftReason,
        };
      }),
    };
  }
}

function setupView(connection: WhatsappConnectionRecord) {
  return {
    health: {
      stateReason: connection.stateReason,
      qualityRating: connection.qualityRating,
      degradedClass: connection.degradedClass,
      lastCheckedAt: connection.lastHealthAt,
    },
    state: connection.state,
    thankYouEnabled: connection.thankYouEnabled,
    signupPath: connection.signupPath,
    displayPhoneNumber: connection.displayPhoneNumber,
    setup: {
      status: connection.setupStatus,
      step: connection.setupStep,
      errorCode: connection.setupErrorCode,
      retryAt:
        connection.setupStatus === 'failed'
          ? connection.setupNextAttemptAt
          : null,
      subscribedAt: connection.subscribedAt,
      numberVerifiedAt: connection.numberVerifiedAt,
      registeredAt: connection.registeredAt,
      completedAt: connection.setupCompletedAt,
    },
  };
}
