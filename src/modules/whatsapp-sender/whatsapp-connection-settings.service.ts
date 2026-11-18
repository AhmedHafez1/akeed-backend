import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { WhatsappConnectionsRepository } from '../../infrastructure/database/repositories/whatsapp-connections.repository';
import { IntegrationsRepository } from '../../infrastructure/database/repositories/integrations.repository';
import { ConfigService } from '@nestjs/config';
import { readWhatsappTemplateConfig } from '../../shared/config/whatsapp-template.config';
import {
  resolveFallbackActiveIntegration,
  resolveShopifyLinkedIntegration,
} from '../../shared/commerce/current-integration-resolver';
import { buildBackendLog } from '../../shared/logging/backend-log.util';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { assertOrganizationWriteAllowed } from '../auth/organization-role';
import type { WhatsappConnectionSettingsDto } from './dto/whatsapp-connection-settings.dto';

export function whatsappConnectionSettingsError(
  code:
    | 'WHATSAPP_CONNECTION_SETTINGS_INVALID'
    | 'WHATSAPP_CONNECTION_NOT_FOUND',
): HttpException {
  const missing = code === 'WHATSAPP_CONNECTION_NOT_FOUND';
  const status = missing ? HttpStatus.NOT_FOUND : HttpStatus.BAD_REQUEST;
  return new HttpException(
    {
      statusCode: status,
      error: missing ? 'Not Found' : 'Bad Request',
      code,
      message: missing
        ? 'This organization has no WhatsApp connection.'
        : 'The WhatsApp connection settings are invalid.',
    },
    status,
  );
}

@Injectable()
export class WhatsappConnectionSettingsService {
  private readonly logger = new Logger(WhatsappConnectionSettingsService.name);

  constructor(
    private readonly connections: WhatsappConnectionsRepository,
    private readonly integrations: IntegrationsRepository,
    private readonly config: ConfigService,
  ) {}

  async update(
    user: AuthenticatedUser,
    settings: WhatsappConnectionSettingsDto,
  ): Promise<WhatsappConnectionSettingsDto> {
    assertOrganizationWriteAllowed(user.role, {
      code: 'WHATSAPP_CONNECTION_WRITE_REQUIRED',
      message: 'Owner or admin role is required to change WhatsApp settings.',
    });
    if (!(await this.connections.findByOrg(user.orgId)))
      throw whatsappConnectionSettingsError('WHATSAPP_CONNECTION_NOT_FOUND');
    const source = user.shop
      ? await resolveShopifyLinkedIntegration(this.integrations, {
          orgId: user.orgId,
          shopDomain: user.shop,
          requireActive: true,
        })
      : await resolveFallbackActiveIntegration(this.integrations, user.orgId);
    if (source.outcome !== 'found')
      throw new HttpException(
        {
          statusCode: 409,
          error: 'Conflict',
          code: 'ONBOARDING_SOURCE_AMBIGUOUS',
          message: 'The current commerce source is unavailable.',
        },
        HttpStatus.CONFLICT,
      );
    const saved = await this.integrations.updateAcknowledgmentPreference(
      user.orgId,
      source.integration.id,
      settings.thankYouEnabled,
      readWhatsappTemplateConfig(this.config).messageImprovements
        .acknowledgment,
    );
    if (!saved)
      throw whatsappConnectionSettingsError('WHATSAPP_CONNECTION_NOT_FOUND');
    this.logger.log(
      buildBackendLog(WhatsappConnectionSettingsService.name, {
        action: 'whatsapp-connection-settings-update',
        outcome: 'success',
        orgId: user.orgId,
        thankYouEnabled: saved.acknowledgmentEnabled,
      }),
    );
    return { thankYouEnabled: saved.acknowledgmentEnabled };
  }
}
