import { createHash } from 'crypto';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { IntegrationsRepository } from '../../infrastructure/database/repositories/integrations.repository';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import {
  PUBLIC_ASSET_STORAGE_PORT,
  PublicAssetStorageError,
  type PublicAssetStoragePort,
} from '../../shared/ports/public-asset-storage.port';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { includesLogoHeader } from '../../shared/billing/plan-features';
import { canWriteOrganization } from '../auth/organization-role';
import { OnboardingStateService } from '../onboarding/onboarding-state.service';
import {
  LogoImageError,
  LogoImageService,
  type LogoImageRejection,
} from './logo-image.service';
import { logoError, type LogoErrorCode } from './merchant-branding.errors';
import {
  logoHeaderAccess,
  type MerchantBrandingDto,
} from './merchant-branding.types';

const REJECTION_CODES: Record<LogoImageRejection, LogoErrorCode> = {
  too_large: 'LOGO_FILE_TOO_LARGE',
  unsupported_type: 'LOGO_FILE_TYPE_UNSUPPORTED',
  unreadable: 'LOGO_IMAGE_UNREADABLE',
  too_small: 'LOGO_IMAGE_TOO_SMALL',
};

/**
 * The store's logo: validated and rendered into a banner, stored publicly,
 * and recorded on the store. A new logo always gets new file names, so the
 * provider never shows a cached old banner, and the replaced files are
 * removed only after the store points at the new ones.
 */
@Injectable()
export class MerchantBrandingService {
  private readonly logger = new Logger(MerchantBrandingService.name);

  constructor(
    private readonly onboardingState: OnboardingStateService,
    private readonly integrationsRepo: IntegrationsRepository,
    private readonly images: LogoImageService,
    @Inject(PUBLIC_ASSET_STORAGE_PORT)
    private readonly storage: PublicAssetStoragePort,
  ) {}

  async uploadLogo(
    user: AuthenticatedUser,
    file: { buffer: Buffer } | undefined,
  ): Promise<MerchantBrandingDto> {
    this.assertWriter(user);
    if (!file?.buffer?.byteLength) throw logoError('LOGO_FILE_REQUIRED');
    const integration =
      await this.onboardingState.resolveCurrentIntegration(user);
    // Below the plan the card is locked; a saved logo may still be removed.
    if (!includesLogoHeader(integration)) throw logoError('LOGO_PLAN_REQUIRED');

    let rendered: Awaited<ReturnType<LogoImageService['render']>>;
    try {
      rendered = await this.images.render(file.buffer);
    } catch (error) {
      if (error instanceof LogoImageError) {
        throw logoError(REJECTION_CODES[error.reason]);
      }
      throw error;
    }

    const version = createHash('sha256')
      .update(rendered.logo)
      .update(rendered.banner)
      .digest('hex')
      .slice(0, 16);
    let logoUrl: string;
    let logoBannerUrl: string;
    try {
      [logoUrl, logoBannerUrl] = await Promise.all([
        this.storage.put(
          `${integration.id}/${version}-logo.png`,
          rendered.logo,
          'image/png',
        ),
        this.storage.put(
          `${integration.id}/${version}-banner.jpg`,
          rendered.banner,
          'image/jpeg',
        ),
      ]);
    } catch (error) {
      this.logger.error(
        buildBackendLog(MerchantBrandingService.name, {
          action: 'merchant-logo-upload',
          outcome: 'failure',
          orgId: user.orgId,
          integrationId: integration.id,
          errorCode: 'storage_unavailable',
          ...storageFailureFields(error),
          ...normalizeError(error),
        }),
      );
      throw logoError('LOGO_STORAGE_UNAVAILABLE');
    }

    const previous = await this.integrationsRepo.replaceLogo(
      integration.id,
      user.orgId,
      { logoUrl, logoBannerUrl },
    );
    if (!previous) throw new NotFoundException();
    await this.removeReplaced(user.orgId, integration.id, previous, [
      logoUrl,
      logoBannerUrl,
    ]);

    this.logger.log(
      buildBackendLog(MerchantBrandingService.name, {
        action: 'merchant-logo-upload',
        outcome: 'success',
        orgId: user.orgId,
        integrationId: integration.id,
        logoBytes: rendered.logo.byteLength,
        bannerBytes: rendered.banner.byteLength,
      }),
    );
    return {
      logoUrl,
      bannerUrl: logoBannerUrl,
      updatedAt: new Date().toISOString(),
      ...logoHeaderAccess(integration),
    };
  }

  async removeLogo(user: AuthenticatedUser): Promise<MerchantBrandingDto> {
    this.assertWriter(user);
    const integration =
      await this.onboardingState.resolveCurrentIntegration(user);
    const previous = await this.integrationsRepo.replaceLogo(
      integration.id,
      user.orgId,
      null,
    );
    if (!previous) throw new NotFoundException();
    await this.removeReplaced(user.orgId, integration.id, previous, []);
    this.logger.log(
      buildBackendLog(MerchantBrandingService.name, {
        action: 'merchant-logo-remove',
        outcome: 'success',
        orgId: user.orgId,
        integrationId: integration.id,
      }),
    );
    return {
      logoUrl: null,
      bannerUrl: null,
      updatedAt: null,
      ...logoHeaderAccess(integration),
    };
  }

  /**
   * The store already points at the new files, so a failed cleanup leaves
   * only unused files behind: logged, never a failed save.
   */
  private async removeReplaced(
    orgId: string,
    integrationId: string,
    previous: { logoUrl: string | null; logoBannerUrl: string | null },
    keep: readonly string[],
  ): Promise<void> {
    const stale = [previous.logoUrl, previous.logoBannerUrl].filter(
      (url): url is string => !!url && !keep.includes(url),
    );
    if (stale.length === 0) return;
    try {
      await this.storage.removeByUrls(stale);
    } catch (error) {
      this.logger.warn(
        buildBackendLog(MerchantBrandingService.name, {
          action: 'merchant-logo-cleanup',
          outcome: 'failure',
          orgId,
          integrationId,
          ...storageFailureFields(error),
          ...normalizeError(error),
        }),
      );
    }
  }

  private assertWriter(user: AuthenticatedUser): void {
    if (!canWriteOrganization(user.role))
      throw logoError('LOGO_WRITE_FORBIDDEN');
  }
}

/** Why the storage refused, when it said. */
function storageFailureFields(error: unknown): Record<string, string> {
  if (!(error instanceof PublicAssetStorageError)) return {};
  const fields: Record<string, string> = { storageReason: error.reason };
  if (error.detail.providerStatus)
    fields.storageStatus = error.detail.providerStatus;
  if (error.detail.providerMessage)
    fields.storageMessage = error.detail.providerMessage;
  return fields;
}
