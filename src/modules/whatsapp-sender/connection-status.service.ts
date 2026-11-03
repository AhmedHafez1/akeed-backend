import { Injectable } from '@nestjs/common';
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
 * account; a connection is never shown as able to send from this view.
 */
@Injectable()
export class ConnectionStatusService {
  constructor(
    private readonly connections: WhatsappConnectionsRepository,
    private readonly rows: WhatsappConnectionTemplatesRepository,
    private readonly registry: WhatsappTemplatesRepository,
  ) {}

  /** For a member of the organization. Null when it has no connection. */
  async forOrganization(
    orgId: string,
  ): Promise<WhatsappConnectionStatusDto | null> {
    const connection = await this.connections.findByOrg(orgId);
    if (!connection) return null;
    const rows =
      connection.state === 'disconnected'
        ? []
        : await this.rows.listForConnection(orgId, connection.id);
    return {
      ...setupView(connection),
      templates: summarizeTemplates(rows),
    };
  }

  /** For staff: the same, with each template's outcome. */
  async forStaff(
    orgId: string,
  ): Promise<WhatsappConnectionStaffViewDto | null> {
    const status = await this.forOrganization(orgId);
    if (!status) return null;
    const connection = (await this.connections.findByOrg(orgId))!;
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

function setupView(
  connection: WhatsappConnectionRecord,
): Omit<WhatsappConnectionStatusDto, 'templates'> {
  return {
    state: connection.state,
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
