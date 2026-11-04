import { Injectable } from '@nestjs/common';
import { SenderAlertService } from './sender-alert.service';
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
  alerts: [],
};

@Injectable()
export class WhatsappSenderService {
  constructor(
    private readonly config: ConfigService,
    private readonly alerts: SenderAlertService,
  ) {}

  /**
   * Whether this organization may connect its own number, from the connect
   * switch. The same for every role, except `canConnect`, which
   * tells the screen whether to offer the owner-only connect action; the
   * connect endpoints check the role again.
   */
  async getAvailability(
    user: AuthenticatedUser,
  ): Promise<WhatsappSenderAvailabilityDto> {
    const alerts = await this.alerts.read(user.orgId);
    const config = readWhatsappOwnNumberConfig(this.config);
    if (
      !isOwnNumberConnectAllowed(config) ||
      !config.metaAppId ||
      !config.embeddedSignupConfigId ||
      !config.connectPageBaseUrl
    )
      return { ...UNAVAILABLE, alerts };
    return {
      alerts,
      available: true,
      appId: config.metaAppId,
      configId: config.embeddedSignupConfigId,
      canConnect: canChangeWhatsappConnection(user.role),
    };
  }
}
