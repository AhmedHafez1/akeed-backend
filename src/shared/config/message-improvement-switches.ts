import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MESSAGE_IMPROVEMENT_SWITCHES_OFF,
  readWhatsappTemplateConfig,
  type MessageImprovementSwitchState,
} from './whatsapp-template.config';

/**
 * The message-improvement switches for code that has no `ConfigService` of its own, the
 * send path among it. Without a validated configuration every switch reads
 * off.
 */
@Injectable()
export class MessageImprovementSwitches {
  constructor(@Optional() private readonly config?: ConfigService) {}

  current(): MessageImprovementSwitchState {
    if (!this.config) return MESSAGE_IMPROVEMENT_SWITCHES_OFF;
    return readWhatsappTemplateConfig(this.config).messageImprovements;
  }
}
