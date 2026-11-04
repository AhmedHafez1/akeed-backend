import { Inject, Injectable, Logger } from '@nestjs/common';
import { WhatsappConnectionsRepository } from '../../infrastructure/database/repositories/whatsapp-connections.repository';
import {
  SENDER_HEALTH_PORT,
  SENDER_EVENT_PORT,
  type SenderHealthPort,
  type SenderEventPort,
  type SenderHealthResult,
} from '../../shared/ports/sender-recovery.port';
import { buildBackendLog } from '../../shared/logging/backend-log.util';
import { WhatsappConnectionSetupProducer } from './whatsapp-connection-setup.producer';

@Injectable()
export class ConnectionHealthService {
  private readonly logger = new Logger(ConnectionHealthService.name);
  constructor(
    private readonly connections: WhatsappConnectionsRepository,
    @Inject(SENDER_HEALTH_PORT) private readonly provider: SenderHealthPort,
    @Inject(SENDER_EVENT_PORT) private readonly events: SenderEventPort,
    private readonly producer: WhatsappConnectionSetupProducer,
  ) {}
  async sweep(): Promise<void> {
    for (const row of await this.connections.findDueHealth())
      await this.producer.requestHealth(
        row.orgId,
        row.id,
        row.signupGeneration,
      );
  }
  async run(orgId: string, id: string, generation: number): Promise<void> {
    const claim = await this.connections.claimHealth(orgId, id, generation);
    if (!claim) return;
    let result: SenderHealthResult;
    try {
      result = await this.provider.check({
        orgId,
        connectionId: id,
        signupGeneration: generation,
      });
    } catch {
      result = { status: 'unknown' };
    }
    const row = await this.connections.completeHealth(claim, result);
    if (!row) return;
    const kind =
      claim.state !== row.state && row.state === 'active'
        ? 'activated'
        : claim.degradedClass !== row.degradedClass
          ? row.degradedClass
            ? 'degraded'
            : 'recovered'
          : null;
    if (kind)
      await this.events.emit({
        orgId,
        connectionId: id,
        kind,
        dedupeKey: `health:${id}:${generation}:${claim.healthRevision}:${row.lastHealthAt}`,
        ...(row.degradedClass ? { failureClass: row.degradedClass } : {}),
      });
    this.logger.log(
      buildBackendLog(ConnectionHealthService.name, {
        action: 'whatsapp-connection-health',
        outcome: result.status === 'unknown' ? 'retry' : 'success',
        orgId,
        connectionId: id,
        healthStatus: result.status,
      }),
    );
  }
}
