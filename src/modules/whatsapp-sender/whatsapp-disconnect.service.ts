import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WhatsappConnectionsRepository } from '../../infrastructure/database/repositories/whatsapp-connections.repository';
import { OwnNumberGraphClient } from '../../infrastructure/spokes/meta/own-number/own-number-graph.client';
import { readBusinessToken } from '../../infrastructure/spokes/meta/own-number/whatsapp-connection-credentials';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { assertWhatsappConnectionChangeAllowed } from './whatsapp-connection-access.policy';
import { buildBackendLog } from '../../shared/logging/backend-log.util';

export interface WhatsappDisconnectResponseDto {
  state: 'disconnected';
  providerCleanup: 'succeeded' | 'manual_required' | 'not_needed';
  businessAppSteps: readonly string[];
}

@Injectable()
export class WhatsappDisconnectService {
  private readonly logger = new Logger(WhatsappDisconnectService.name);
  constructor(
    private readonly connections: WhatsappConnectionsRepository,
    private readonly graph: OwnNumberGraphClient,
    private readonly config: ConfigService,
  ) {}

  async disconnect(
    user: AuthenticatedUser,
  ): Promise<WhatsappDisconnectResponseDto> {
    assertWhatsappConnectionChangeAllowed(user.role);
    const row = await this.connections.beginDisconnect(user.orgId);
    if (!row) {
      const current = await this.connections.findByOrg(user.orgId);
      return {
        state: 'disconnected',
        providerCleanup: current?.providerCleanup ?? 'not_needed',
        businessAppSteps:
          current?.signupPath === 'coexistence'
            ? ['settings', 'account', 'business_platform', 'disconnect']
            : [],
      };
    }
    let cleanup: 'succeeded' | 'manual_required' = 'manual_required';
    try {
      const token = readBusinessToken(
        row,
        this.config.get<string>('SHOPIFY_TOKEN_ENCRYPTION_KEY') ?? '',
      );
      if (
        token &&
        (
          await this.graph.unsubscribeApp({
            wabaId: row.wabaId,
            businessToken: token,
          })
        ).ok
      )
        cleanup = 'succeeded';
    } catch {
      // The local disconnect is already committed. Never undo it for provider I/O.
      this.logger.warn(
        buildBackendLog(WhatsappDisconnectService.name, {
          action: 'whatsapp-disconnect-cleanup',
          outcome: 'failure',
          orgId: user.orgId,
          errorCode: 'provider_cleanup_required',
        }),
      );
    } finally {
      await this.connections.finishDisconnect(
        user.orgId,
        row.id,
        row.signupGeneration,
        cleanup,
      );
    }
    this.logger.log(
      buildBackendLog(WhatsappDisconnectService.name, {
        action: 'whatsapp-disconnect',
        outcome: 'success',
        orgId: user.orgId,
        providerCleanup: cleanup,
      }),
    );
    return {
      state: 'disconnected',
      providerCleanup: cleanup,
      businessAppSteps:
        row.signupPath === 'coexistence'
          ? ['settings', 'account', 'business_platform', 'disconnect']
          : [],
    };
  }
}
