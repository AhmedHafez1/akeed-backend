import { ForbiddenException } from '@nestjs/common';

export const ORGANIZATION_ROLES = ['owner', 'admin', 'viewer'] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export function isOrganizationRole(value: unknown): value is OrganizationRole {
  return ORGANIZATION_ROLES.includes(value as OrganizationRole);
}

export function canWriteOrganization(role: OrganizationRole): boolean {
  return role === 'owner' || role === 'admin';
}

export function assertOrganizationWriteAllowed(
  role: OrganizationRole,
  options: { code: string; message: string },
): void {
  if (canWriteOrganization(role)) return;

  throw new ForbiddenException({
    statusCode: 403,
    error: 'Forbidden',
    message: options.message,
    code: options.code,
  });
}
