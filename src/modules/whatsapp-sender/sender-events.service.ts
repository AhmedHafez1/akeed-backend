import { Injectable, Logger } from '@nestjs/common';
import type {
  SenderEvent,
  SenderEventPort,
} from '../../shared/ports/sender-recovery.port';
import { SenderAlertProducer } from './sender-alert-queue';
import { buildBackendLog } from '../../shared/logging/backend-log.util';

/** Notifications schedule background work and never wait for email. */
@Injectable()
export class SenderEventsService implements SenderEventPort {
  constructor(private readonly alerts: SenderAlertProducer) {}
  private readonly logger = new Logger(SenderEventsService.name);
  emit(event: SenderEvent): Promise<void> {
    this.logger.log(
      buildBackendLog(SenderEventsService.name, {
        action: 'whatsapp-sender-event',
        outcome: 'success',
        ...event,
      }),
    );
    this.alerts.request(event.orgId, event.signupGeneration);
    return Promise.resolve();
  }
}
