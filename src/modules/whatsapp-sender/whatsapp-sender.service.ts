import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import {
  isOwnNumberConnectAllowed,
  readWhatsappOwnNumberConfig,
} from '../../shared/config/whatsapp-own-number.config';
import type { WhatsappSenderAvailabilityDto } from './dto/whatsapp-sender.dto';
import { canChangeWhatsappConnection } from './whatsapp-connection-access.policy';

const UNAVAILABLE: WhatsappSenderAvailabilityDto = {
  available: false,
  appId: null,
  configId: null,
  canConnect: false,
};

@Injectable()
export class WhatsappSenderService {
  constructor(private readonly config: ConfigService) {}

  /**
   * Whether this organization may connect its own number, from the connect
   * switch. The same for every role, except `canConnect`, which
   * tells the screen whether to offer the owner-only connect action; the
   * connect endpoints check the role again.
   */
  getAvailability(user: AuthenticatedUser): WhatsappSenderAvailabilityDto {
    const config = readWhatsappOwnNumberConfig(this.config);
    if (
      !isOwnNumberConnectAllowed(config) ||
      !config.metaAppId ||
      !config.embeddedSignupConfigId ||
      !config.connectPageBaseUrl
    )
      return { ...UNAVAILABLE };
    return {
      available: true,
      appId: config.metaAppId,
      configId: config.embeddedSignupConfigId,
      canConnect: canChangeWhatsappConnection(user.role),
    };
  }
}
