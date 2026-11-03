import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WhatsappConnectionsRepository } from '../../infrastructure/database/repositories/whatsapp-connections.repository';
import { WhatsappConnectionTemplatesRepository } from '../../infrastructure/database/repositories/whatsapp-connection-templates.repository';
import { readWhatsappOwnNumberConfig } from '../../shared/config/whatsapp-own-number.config';
import type { SenderResolverPort } from '../../shared/ports/sender-resolver.port';
import { resolveSender } from './sender-resolution.policy';

@Injectable()
export class SenderResolverService implements SenderResolverPort {
  constructor(
    private readonly config: ConfigService,
    private readonly connections: WhatsappConnectionsRepository,
    private readonly templates: WhatsappConnectionTemplatesRepository,
  ) {}

  async resolve(params: Parameters<SenderResolverPort['resolve']>[0]) {
    const enabled = readWhatsappOwnNumberConfig(this.config).sendingEnabled;
    if (!enabled)
      return resolveSender({ enabled, connection: null, template: null });
    const connection = await this.connections.findByOrg(params.orgId);
    const eligibility = resolveSender({ enabled, connection, template: null });
    if (!connection || eligibility.reason !== 'template_missing')
      return eligibility;
    const template = await this.templates.findForSend(
      params.orgId,
      connection.id,
      params.template,
    );
    return resolveSender({ enabled, connection, template });
  }

  async predict(orgId: string) {
    const enabled = readWhatsappOwnNumberConfig(this.config).sendingEnabled;
    if (!enabled) return 'akeed_system' as const;
    const connection = await this.connections.findByOrg(orgId);
    // With no template given, passing every connection check stops at
    // `template_missing`: the number itself can send.
    return connection &&
      resolveSender({ enabled, connection, template: null }).reason ===
        'template_missing'
      ? ('merchant_own' as const)
      : ('akeed_system' as const);
  }
}
