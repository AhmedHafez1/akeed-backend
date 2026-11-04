import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { WhatsappConnectionsRepository } from '../../infrastructure/database/repositories/whatsapp-connections.repository';
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

  constructor(private readonly connections: WhatsappConnectionsRepository) {}

  async update(
    user: AuthenticatedUser,
    settings: WhatsappConnectionSettingsDto,
  ): Promise<WhatsappConnectionSettingsDto> {
    assertOrganizationWriteAllowed(user.role, {
      code: 'WHATSAPP_CONNECTION_WRITE_REQUIRED',
      message: 'Owner or admin role is required to change WhatsApp settings.',
    });
    const saved = await this.connections.updateThankYouEnabled(
      user.orgId,
      settings.thankYouEnabled,
    );
    if (!saved)
      throw whatsappConnectionSettingsError('WHATSAPP_CONNECTION_NOT_FOUND');
    this.logger.log(
      buildBackendLog(WhatsappConnectionSettingsService.name, {
        action: 'whatsapp-connection-settings-update',
        outcome: 'success',
        orgId: user.orgId,
        thankYouEnabled: saved.thankYouEnabled,
      }),
    );
    return saved;
  }
}
