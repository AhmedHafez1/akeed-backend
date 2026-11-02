import { ForbiddenException } from '@nestjs/common';
import type { OrganizationRole } from '../auth/organization-role';

export const WHATSAPP_CONNECTION_OWNER_REQUIRED =
  'WHATSAPP_CONNECTION_OWNER_REQUIRED';

/**
 * Connecting or disconnecting the number messages go out from is the owner's
 * call. Stricter than `canWriteOrganization`, which also lets admins write.
 */
export function canChangeWhatsappConnection(role: OrganizationRole): boolean {
  return role === 'owner';
}

export function assertWhatsappConnectionChangeAllowed(
  role: OrganizationRole,
): void {
  if (canChangeWhatsappConnection(role)) return;
  throw new ForbiddenException({
    statusCode: 403,
    error: 'Forbidden',
    message: 'Owner role is required to change the WhatsApp connection',
    code: WHATSAPP_CONNECTION_OWNER_REQUIRED,
  });
}
