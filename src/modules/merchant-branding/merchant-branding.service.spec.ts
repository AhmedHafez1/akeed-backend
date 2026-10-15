import { HttpException, Logger } from '@nestjs/common';
import { PublicAssetStorageError } from '../../shared/ports/public-asset-storage.port';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { LogoImageError } from './logo-image.service';
import { MerchantBrandingService } from './merchant-branding.service';

const ORG = 'org-1';
const OLD = {
  logoUrl: 'https://cdn.test/merchant-logos/int-1/old-logo.png',
  logoBannerUrl: 'https://cdn.test/merchant-logos/int-1/old-banner.jpg',
};

function user(role: AuthenticatedUser['role'] = 'owner'): AuthenticatedUser {
  return {
    userId: 'u-1',
    orgId: ORG,
    role,
    source: 'supabase',
  } as AuthenticatedUser;
}

function setup() {
  const calls: string[] = [];
  const onboardingState = {
    resolveCurrentIntegration: jest
      .fn()
      .mockResolvedValue({ id: 'int-1', logoHeaderEnabled: true }),
  };
  const integrationsRepo = {
    replaceLogo: jest.fn(() => {
      calls.push('replaceLogo');
      return Promise.resolve(OLD);
    }),
  };
  const images = {
    render: jest.fn().mockResolvedValue({
      logo: Buffer.from('logo'),
      banner: Buffer.from('banner'),
    }),
  };
  const storage = {
    put: jest.fn((path: string) => {
      calls.push(`put:${path}`);
      return Promise.resolve(`https://cdn.test/merchant-logos/${path}`);
    }),
    removeByUrls: jest.fn(() => {
      calls.push('remove');
      return Promise.resolve();
    }),
  };
  const service = new MerchantBrandingService(
    onboardingState as never,
    integrationsRepo as never,
    images as never,
    storage,
  );
  return { service, onboardingState, integrationsRepo, images, storage, calls };
}

async function errorCode(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof HttpException) {
      return (error.getResponse() as { code: string }).code;
    }
    throw error;
  }
  return 'no error';
}

const file = { buffer: Buffer.from('png bytes') };

describe('MerchantBrandingService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('stores both files under content names, then points the store at them, then removes the old ones', async () => {
    const { service, integrationsRepo, storage, calls } = setup();

    const result = await service.uploadLogo(user(), file);

    const puts = calls.filter((call) => call.startsWith('put:'));
    expect(puts).toHaveLength(2);
    expect(puts[0]).toMatch(/^put:int-1\/[0-9a-f]{16}-logo\.png$/);
    expect(puts[1]).toMatch(/^put:int-1\/[0-9a-f]{16}-banner\.jpg$/);
    expect(calls.slice(2)).toEqual(['replaceLogo', 'remove']);
    expect(integrationsRepo.replaceLogo).toHaveBeenCalledWith('int-1', ORG, {
      logoUrl: result.logoUrl,
      logoBannerUrl: result.bannerUrl,
    });
    expect(storage.removeByUrls).toHaveBeenCalledWith([
      OLD.logoUrl,
      OLD.logoBannerUrl,
    ]);
    expect(result.logoHeaderAvailable).toBe(true);
  });

  it('refuses a viewer before reading anything', async () => {
    const { service, onboardingState, images } = setup();
    expect(await errorCode(service.uploadLogo(user('viewer'), file))).toBe(
      'LOGO_WRITE_FORBIDDEN',
    );
    expect(await errorCode(service.removeLogo(user('viewer')))).toBe(
      'LOGO_WRITE_FORBIDDEN',
    );
    expect(onboardingState.resolveCurrentIntegration).not.toHaveBeenCalled();
    expect(images.render).not.toHaveBeenCalled();
  });

  it('requires a file', async () => {
    const { service } = setup();
    expect(await errorCode(service.uploadLogo(user(), undefined))).toBe(
      'LOGO_FILE_REQUIRED',
    );
  });

  it.each([
    ['unsupported_type', 'LOGO_FILE_TYPE_UNSUPPORTED'],
    ['too_small', 'LOGO_IMAGE_TOO_SMALL'],
    ['unreadable', 'LOGO_IMAGE_UNREADABLE'],
    ['too_large', 'LOGO_FILE_TOO_LARGE'],
  ] as const)('maps %s to %s and stores nothing', async (reason, code) => {
    const { service, images, storage, integrationsRepo } = setup();
    images.render.mockRejectedValue(new LogoImageError(reason));
    expect(await errorCode(service.uploadLogo(user(), file))).toBe(code);
    expect(storage.put).not.toHaveBeenCalled();
    expect(integrationsRepo.replaceLogo).not.toHaveBeenCalled();
  });

  it('leaves the store as it was when storage fails', async () => {
    const { service, storage, integrationsRepo } = setup();
    storage.put.mockRejectedValue(new PublicAssetStorageError('timeout'));
    expect(await errorCode(service.uploadLogo(user(), file))).toBe(
      'LOGO_STORAGE_UNAVAILABLE',
    );
    expect(integrationsRepo.replaceLogo).not.toHaveBeenCalled();
  });

  it('still saves when removing the old files fails', async () => {
    const { service, storage } = setup();
    storage.removeByUrls.mockRejectedValue(new PublicAssetStorageError('x'));
    const result = await service.uploadLogo(user(), file);
    expect(result.logoUrl).toMatch(/-logo\.png$/);
  });

  it('scopes the write to the caller org and clears on remove', async () => {
    const { service, integrationsRepo, storage } = setup();
    const result = await service.removeLogo(user('admin'));
    expect(integrationsRepo.replaceLogo).toHaveBeenCalledWith(
      'int-1',
      ORG,
      null,
    );
    expect(storage.removeByUrls).toHaveBeenCalledWith([
      OLD.logoUrl,
      OLD.logoBannerUrl,
    ]);
    expect(result).toEqual({
      logoUrl: null,
      bannerUrl: null,
      updatedAt: null,
      logoHeaderAvailable: true,
    });
  });
});
