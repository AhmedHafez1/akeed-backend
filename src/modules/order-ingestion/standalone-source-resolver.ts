import {
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { IntegrationsRepository } from '../../infrastructure/database/repositories/integrations.repository';
import type { integrations } from '../../infrastructure/database/schema';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { assertOrganizationWriteAllowed } from '../auth/organization-role';

export type StandaloneSource = typeof integrations.$inferSelect;

interface DenialCopy {
  code: string;
  message: string;
}

/**
 * The codes and messages one channel answers with when the caller cannot write
 * Standalone orders. The statuses are fixed by the resolver so every channel
 * denies the same situation the same way; only the vocabulary differs.
 */
export interface StandaloneSourceCodeMap {
  /** 403: the caller is a viewer. */
  roleRequired: DenialCopy;
  /** 409: the organization has no active source. */
  sourceUnavailable: DenialCopy;
  /** 409: the organization has more than one active source. */
  sourceAmbiguous: DenialCopy;
  /** 403: the single active source is not Standalone. */
  sourceUnsupported: DenialCopy;
  /** 409: Standalone onboarding is not completed. */
  setupIncomplete: DenialCopy;
}

export const MANUAL_ORDER_SOURCE_CODES: StandaloneSourceCodeMap = {
  roleRequired: {
    code: 'MANUAL_ORDER_ROLE_REQUIRED',
    message: 'Owner or admin role is required to create an order.',
  },
  sourceUnavailable: {
    code: 'MANUAL_ORDER_SOURCE_UNAVAILABLE',
    message: 'Exactly one active commerce source is required.',
  },
  sourceAmbiguous: {
    code: 'MANUAL_ORDER_SOURCE_AMBIGUOUS',
    message: 'Exactly one active commerce source is required.',
  },
  sourceUnsupported: {
    code: 'MANUAL_ORDER_SOURCE_UNSUPPORTED',
    message: 'Manual order creation is available only for Standalone.',
  },
  setupIncomplete: {
    code: 'MANUAL_ORDER_SETUP_INCOMPLETE',
    message: 'Complete Standalone setup before creating an order.',
  },
};

/**
 * The epic has one "unsupported source" code for import: a merchant without
 * exactly one active Standalone source cannot import, whatever the cause.
 */
export const IMPORT_SOURCE_CODES: StandaloneSourceCodeMap = {
  roleRequired: {
    code: 'IMPORT_ROLE_REQUIRED',
    message: 'Owner or admin role is required to import orders.',
  },
  sourceUnavailable: {
    code: 'IMPORT_SOURCE_UNSUPPORTED',
    message: 'Exactly one active Standalone store is required to import.',
  },
  sourceAmbiguous: {
    code: 'IMPORT_SOURCE_UNSUPPORTED',
    message: 'Exactly one active Standalone store is required to import.',
  },
  sourceUnsupported: {
    code: 'IMPORT_SOURCE_UNSUPPORTED',
    message: 'Importing orders from a file is available only for Standalone.',
  },
  setupIncomplete: {
    code: 'IMPORT_SETUP_INCOMPLETE',
    message: 'Complete Standalone setup before importing orders.',
  },
};

/**
 * Resolves the one Standalone source a caller may write orders into.
 *
 * Every Standalone channel (manual form, file import, later the API) goes
 * through this, so "who may write, into which source" is decided in one place.
 * The source always comes from the session's organization, never the request.
 */
@Injectable()
export class StandaloneSourceResolver {
  constructor(private readonly integrationsRepo: IntegrationsRepository) {}

  assertWritableRole(
    user: AuthenticatedUser,
    codes: StandaloneSourceCodeMap,
  ): void {
    assertOrganizationWriteAllowed(user.role, codes.roleRequired);
  }

  async resolveWritable(
    user: AuthenticatedUser,
    codes: StandaloneSourceCodeMap,
  ): Promise<StandaloneSource> {
    this.assertWritableRole(user, codes);
    const sources = await this.integrationsRepo.findActiveByOrg(user.orgId);
    if (sources.length !== 1 || sources[0].orgId !== user.orgId) {
      const copy =
        sources.length > 1 ? codes.sourceAmbiguous : codes.sourceUnavailable;
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: copy.message,
        code: copy.code,
      });
    }
    const source = sources[0];
    if (source.platformType !== 'standalone') {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        message: codes.sourceUnsupported.message,
        code: codes.sourceUnsupported.code,
      });
    }
    if (source.onboardingStatus !== 'completed') {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: codes.setupIncomplete.message,
        code: codes.setupIncomplete.code,
      });
    }
    return source;
  }
}
