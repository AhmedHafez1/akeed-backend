import { ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { TokenValidatorService } from './token-validator.service';

function token(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.');
}

function createService(params?: { role?: string; aal2Required?: boolean }) {
  const config = {
    getOrThrow: jest.fn((key: string) =>
      key === 'SUPABASE_URL' ? 'https://example.supabase.co' : 'service-key',
    ),
    get: jest.fn((key: string) => {
      if (key === 'ADMIN_REQUIRE_AAL2')
        return params?.aal2Required === false ? 'false' : 'true';
      if (key === 'NODE_ENV') return 'production';
      return undefined;
    }),
  };
  const service = new TokenValidatorService(
    config as unknown as ConfigService,
    {} as never,
    {} as never,
  );
  Object.defineProperty(service, 'supabase', {
    value: {
      auth: {
        getUser: jest.fn().mockResolvedValue({
          data: {
            user: {
              id: 'staff-1',
              app_metadata: { akeed_role: params?.role ?? 'admin' },
            },
          },
          error: null,
        }),
      },
    },
  });
  return service;
}

describe('TokenValidatorService admin access', () => {
  it('rejects Shopify session tokens', async () => {
    await expect(
      createService().validateAdminToken(
        token({ dest: 'https://shop.myshopify.com', aud: 'shopify-key' }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects Supabase users without app-metadata staff authority', async () => {
    await expect(
      createService({ role: 'merchant' }).validateAdminToken(
        token({ aud: 'authenticated', aal: 'aal2' }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects staff sessions below AAL2 when MFA is required', async () => {
    await expect(
      createService().validateAdminToken(
        token({ aud: 'authenticated', aal: 'aal1' }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('accepts an AAL2 Supabase admin session', async () => {
    await expect(
      createService().validateAdminToken(
        token({ aud: 'authenticated', aal: 'aal2' }),
      ),
    ).resolves.toEqual({
      userId: 'staff-1',
      role: 'admin',
      aal: 'aal2',
      source: 'supabase',
    });
  });
});
