import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import {
  isOwnNumberConnectAllowed,
  readWhatsappOwnNumberConfig,
} from '../../shared/config/whatsapp-own-number.config';
import type { WhatsappSenderAvailabilityDto } from './dto/whatsapp-sender.dto';

const UNAVAILABLE: WhatsappSenderAvailabilityDto = {
  available: false,
  appId: null,
  configId: null,
};

@Injectable()
export class WhatsappSenderService {
  constructor(private readonly config: ConfigService) {}

  /**
   * Whether this organization may connect its own number, from the switches
   * and pilot list alone. The same for every role: changing a connection is
   * checked where it happens.
   */
  getAvailability(user: AuthenticatedUser): WhatsappSenderAvailabilityDto {
    const config = readWhatsappOwnNumberConfig(this.config);
    if (
      !isOwnNumberConnectAllowed(config, user.orgId) ||
      !config.metaAppId ||
      !config.embeddedSignupConfigId
    )
      return { ...UNAVAILABLE };
    return {
      available: true,
      appId: config.metaAppId,
      configId: config.embeddedSignupConfigId,
    };
  }
}
