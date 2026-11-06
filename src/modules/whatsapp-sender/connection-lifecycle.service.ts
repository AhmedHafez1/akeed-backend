import { Inject, Injectable } from '@nestjs/common';
import {
  WhatsappConnectionsRepository,
  type WhatsappConnectionRecord,
} from '../../infrastructure/database/repositories/whatsapp-connections.repository';
import {
  SENDER_EVENT_PORT,
  type SenderEventPort,
} from '../../shared/ports/sender-recovery.port';
import { WhatsappConnectionSetupProducer } from './whatsapp-connection-setup.producer';
import {
  ACCOUNT_LIFECYCLE_EVENTS,
  lifecycleReason,
} from './connection-lifecycle.policy';

@Injectable()
export class ConnectionLifecycleService {
  constructor(
    private readonly connections: WhatsappConnectionsRepository,
    private readonly health: WhatsappConnectionSetupProducer,
    @Inject(SENDER_EVENT_PORT) private readonly events: SenderEventPort,
  ) {}

  async apply(
    connection: WhatsappConnectionRecord,
    input: {
      event: string;
      reason?: unknown;
      eventKey: string;
      occurredAt: string;
    },
  ) {
    if (!ACCOUNT_LIFECYCLE_EVENTS.has(input.event)) return;
    const row = await this.connections.applyLifecycle({
      orgId: connection.orgId,
      connectionId: connection.id,
      generation: connection.signupGeneration,
      ...input,
      reason: lifecycleReason(input.event, input.reason),
    });
    if (!row) return;
    await this.events.emit({
      orgId: row.orgId,
      connectionId: row.id,
      signupGeneration: row.signupGeneration,
      kind:
        row.state === 'disconnected'
          ? 'disconnected'
          : row.state === 'offboarded'
            ? 'offboarded'
            : input.event === 'ACCOUNT_RECONNECTED'
              ? 'reconnecting'
              : 'degraded',
      dedupeKey: `lifecycle:${row.id}:${row.signupGeneration}:${input.eventKey}`,
      reason: row.stateReason ?? undefined,
      ...(row.degradedClass ? { failureClass: row.degradedClass } : {}),
    });
    if (row.state === 'verifying' || row.state === 'active')
      await this.health.requestHealth(row.orgId, row.id, row.signupGeneration);
  }

  async requestHealth(connection: WhatsappConnectionRecord) {
    await this.connections.requestHealth(
      connection.orgId,
      connection.id,
      connection.signupGeneration,
    );
    await this.health.requestHealth(
      connection.orgId,
      connection.id,
      connection.signupGeneration,
    );
  }
}
