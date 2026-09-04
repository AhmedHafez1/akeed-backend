import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { TokenValidatorService } from './token-validator.service';

const SHOPIFY_SECRET = 'shopify-test-secret';
const SHOPIFY_API_KEY = 'shopify-test-key';

function createShopifyToken(): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString(
    'base64url',
  );
  const payload = Buffer.from(
    JSON.stringify({
      iss: 'https://test.myshopify.com/admin',
      dest: 'https://test.myshopify.com',
      aud: SHOPIFY_API_KEY,
      sub: 'merchant-1',
      exp: now + 300,
      nbf: now - 10,
      iat: now - 10,
      jti: 'jwt-1',
      sid: 'session-1',
    }),
  ).toString('base64url');
  const signature = crypto
    .createHmac('sha256', SHOPIFY_SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function createSupabaseToken(): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString(
    'base64url',
  );
  const payload = Buffer.from(
    JSON.stringify({ aud: 'authenticated', role: 'authenticated' }),
  ).toString('base64url');

  return `${header}.${payload}.signature`;
}

function createService(isActive: boolean) {
  const config = {
    getOrThrow: jest.fn((key: string) => {
      const values: Record<string, string> = {
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SHOPIFY_API_SECRET: SHOPIFY_SECRET,
        SHOPIFY_API_KEY,
      };
      return values[key];
    }),
    get: jest.fn(),
  };
  const integrationsRepo = {
    findByPlatformDomain: jest.fn().mockResolvedValue({
      id: 'int-1',
      orgId: 'org-1',
      isActive,
    }),
  };
  const membershipsRepo = {
    findByOrg: jest
      .fn()
      .mockResolvedValue([
        { userId: 'owner-1', orgId: 'org-1', role: 'owner' },
      ]),
    findByUser: jest.fn().mockResolvedValue([]),
  };
  const service = new TokenValidatorService(
    config as unknown as ConfigService,
    integrationsRepo as never,
    membershipsRepo as never,
  );

  return { service, membershipsRepo };
}

function mockSupabaseUser(
  service: TokenValidatorService,
  userId = 'standalone-user-1',
): void {
  const supabase = (
    service as unknown as {
      supabase: {
        auth: {
          getUser: () => Promise<unknown>;
        };
      };
    }
  ).supabase;

  jest.spyOn(supabase.auth, 'getUser').mockResolvedValue({
    data: { user: { id: userId } },
    error: null,
  });
}

describe('TokenValidatorService Shopify installation state', () => {
  it('rejects a valid Shopify session token after uninstall', async () => {
    const { service, membershipsRepo } = createService(false);

    await expect(
      service.validateToken(createShopifyToken()),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(membershipsRepo.findByOrg).not.toHaveBeenCalled();
  });

  it('accepts the same token shape for an installed integration', async () => {
    const { service } = createService(true);

    await expect(service.validateToken(createShopifyToken())).resolves.toEqual({
      userId: 'owner-1',
      orgId: 'org-1',
      role: 'owner',
      source: 'shopify',
      shop: 'test.myshopify.com',
    });
  });
});

describe('TokenValidatorService Supabase organization state', () => {
  it('returns an explicit orgless identity when the endpoint allows it', async () => {
    const { service } = createService(true);
    mockSupabaseUser(service);

    await expect(
      service.validateToken(createSupabaseToken(), { allowMissingOrg: true }),
    ).resolves.toEqual({
      userId: 'standalone-user-1',
      orgId: null,
      role: null,
      source: 'supabase',
    });
  });

  it('returns ORGANIZATION_REQUIRED for strict protected endpoints', async () => {
    const { service } = createService(true);
    mockSupabaseUser(service);

    try {
      await service.validateToken(createSupabaseToken());
      throw new Error('Expected organization validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenException);
      if (!(error instanceof ForbiddenException)) {
        throw error;
      }
      expect(error.getResponse()).toMatchObject({
        code: 'ORGANIZATION_REQUIRED',
      });
    }
  });

  it('uses the deterministic first membership returned by the repository', async () => {
    const { service, membershipsRepo } = createService(true);
    mockSupabaseUser(service);
    membershipsRepo.findByUser.mockResolvedValue([
      { userId: 'standalone-user-1', orgId: 'owned-org', role: 'owner' },
      { userId: 'standalone-user-1', orgId: 'invited-org', role: 'viewer' },
    ]);

    await expect(service.validateToken(createSupabaseToken())).resolves.toEqual(
      {
        userId: 'standalone-user-1',
        orgId: 'owned-org',
        role: 'owner',
        source: 'supabase',
      },
    );
  });

  it('re-resolves a changed role for the same token on every request', async () => {
    const { service, membershipsRepo } = createService(true);
    mockSupabaseUser(service);
    membershipsRepo.findByUser
      .mockResolvedValueOnce([
        {
          userId: 'standalone-user-1',
          orgId: 'org-1',
          role: 'owner',
        },
      ])
      .mockResolvedValueOnce([
        {
          userId: 'standalone-user-1',
          orgId: 'org-1',
          role: 'viewer',
        },
      ])
      .mockResolvedValueOnce([]);

    await expect(
      service.validateToken(createSupabaseToken()),
    ).resolves.toMatchObject({
      orgId: 'org-1',
      role: 'owner',
    });
    await expect(
      service.validateToken(createSupabaseToken()),
    ).resolves.toMatchObject({
      orgId: 'org-1',
      role: 'viewer',
    });
    await expect(
      service.validateToken(createSupabaseToken()),
    ).rejects.toMatchObject({
      response: { code: 'ORGANIZATION_REQUIRED' },
    });
    expect(membershipsRepo.findByUser).toHaveBeenCalledTimes(3);
  });
});
