import { Injectable, Logger } from '@nestjs/common';
import { WhatsappConnectionTemplatesRepository } from '../../infrastructure/database/repositories/whatsapp-connection-templates.repository';
import { WhatsappConnectionsRepository } from '../../infrastructure/database/repositories/whatsapp-connections.repository';
import { buildBackendLog } from '../../shared/logging/backend-log.util';
import type { TemplateProviderEvent } from '../../shared/messaging/template-provider.types';
import { WhatsappConnectionSetupProducer } from './whatsapp-connection-setup.producer';

/**
 * Template webhooks for a merchant's account. The account id picks the one
 * live connection that holds it, so an event can only touch that
 * organization's rows. A status is written as a hint, and a sync of that
 * account is queued; the sync's list decides. An account no connection holds
 * is logged and dropped.
 */
@Injectable()
export class ConnectionTemplateHintsService {
  private readonly logger = new Logger(ConnectionTemplateHintsService.name);

  constructor(
    private readonly connections: WhatsappConnectionsRepository,
    private readonly rows: WhatsappConnectionTemplatesRepository,
    private readonly producer: WhatsappConnectionSetupProducer,
  ) {}

  async apply(
    wabaId: string,
    events: readonly TemplateProviderEvent[],
  ): Promise<void> {
    if (events.length === 0) return;
    const connection = await this.connections.findLiveByWabaId(wabaId);
    if (!connection) {
      this.logger.warn(
        buildBackendLog(ConnectionTemplateHintsService.name, {
          action: 'whatsapp_connection_template_hint',
          outcome: 'skipped',
          reason: 'unknown_account',
          eventCount: events.length,
        }),
      );
      return;
    }
    let applied = 0;
    for (const event of events) {
      if (
        event.field !== 'status' ||
        !event.providerTemplateId ||
        !event.status
      )
        continue;
      const written = await this.rows.applyStatusHint(
        connection.orgId,
        connection.id,
        {
          metaTemplateId: event.providerTemplateId,
          status: event.status,
          occurredAt: event.occurredAt,
        },
      );
      if (written) applied += 1;
    }
    await this.producer.requestTemplateSync(connection.id);
    this.logger.log(
      buildBackendLog(ConnectionTemplateHintsService.name, {
        action: 'whatsapp_connection_template_hint',
        outcome: 'success',
        orgId: connection.orgId,
        connectionId: connection.id,
        eventCount: events.length,
        applied,
      }),
    );
  }
}
