import { Injectable, Optional } from '@nestjs/common';
import { WhatsappSenderReadRepository } from '../../infrastructure/database/repositories/whatsapp-sender-read.repository';
import { canWriteOrganization } from '../auth/organization-role';
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
  sendingEnabled: false,
  permissions: { canDisconnect: false, canUpdateThankYou: false },
  lastAcceptedSend: null,
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
    @Optional() private readonly reads?: WhatsappSenderReadRepository,
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
    const facts = {
      alerts,
      sendingEnabled: config.sendingEnabled,
      lastAcceptedSend: (await this.reads?.lastAccepted(user.orgId)) ?? null,
      permissions: {
        canDisconnect: canChangeWhatsappConnection(user.role),
        canUpdateThankYou: canWriteOrganization(user.role),
      },
    };
    if (
      !isOwnNumberConnectAllowed(config) ||
      !config.metaAppId ||
      !config.embeddedSignupConfigId ||
      !config.connectPageBaseUrl
    )
      return { ...UNAVAILABLE, ...facts };
    return {
      ...facts,
      available: true,
      appId: config.metaAppId,
      configId: config.embeddedSignupConfigId,
      canConnect: canChangeWhatsappConnection(user.role),
    };
  }
}
