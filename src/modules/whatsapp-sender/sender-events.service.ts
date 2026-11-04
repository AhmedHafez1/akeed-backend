import { Injectable, Logger } from '@nestjs/common';
import type {
  SenderEvent,
  SenderEventPort,
} from '../../shared/ports/sender-recovery.port';
import { buildBackendLog } from '../../shared/logging/backend-log.util';

/** Replace this binding with the alert consumer when alert delivery is added. */
@Injectable()
export class SenderEventsService implements SenderEventPort {
  private readonly logger = new Logger(SenderEventsService.name);
  emit(event: SenderEvent): Promise<void> {
    this.logger.log(
      buildBackendLog(SenderEventsService.name, {
        action: 'whatsapp-sender-event',
        outcome: 'success',
        ...event,
      }),
    );
    return Promise.resolve();
  }
}
