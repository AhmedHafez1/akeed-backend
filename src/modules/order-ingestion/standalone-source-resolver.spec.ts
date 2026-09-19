import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import {
  IMPORT_SOURCE_CODES,
  MANUAL_ORDER_SOURCE_CODES,
  StandaloneSourceResolver,
  type StandaloneSourceCodeMap,
} from './standalone-source-resolver';

describe('StandaloneSourceResolver', () => {
  const standalone = {
    id: 'int-1',
    orgId: 'org-1',
    platformType: 'standalone',
    onboardingStatus: 'completed',
  };
  const owner: AuthenticatedUser = {
    userId: 'user-1',
    orgId: 'org-1',
    role: 'owner',
    source: 'supabase',
  };
  const integrations = { findActiveByOrg: jest.fn() };
  const resolver = new StandaloneSourceResolver(integrations as never);

  beforeEach(() => {
    jest.clearAllMocks();
    integrations.findActiveByOrg.mockResolvedValue([standalone]);
  });

  async function denial(
    codes: StandaloneSourceCodeMap,
    user: AuthenticatedUser = owner,
  ): Promise<{ status: number; body: unknown }> {
    try {
      await resolver.resolveWritable(user, codes);
    } catch (error) {
      const http = error as { getStatus(): number; getResponse(): unknown };
      return { status: http.getStatus(), body: http.getResponse() };
    }
    throw new Error('expected a denial');
  }

  it.each(['owner', 'admin'] as const)(
    'resolves the single completed Standalone source for an %s',
    async (role) => {
      await expect(
        resolver.resolveWritable({ ...owner, role }, IMPORT_SOURCE_CODES),
      ).resolves.toBe(standalone);
      expect(integrations.findActiveByOrg).toHaveBeenCalledWith('org-1');
    },
  );

  // The manual responses are the contract the frontend already switches on,
  // so the bodies are asserted in full.
  describe('manual-order code map', () => {
    it('refuses a viewer before reading any source', async () => {
      await expect(
        denial(MANUAL_ORDER_SOURCE_CODES, { ...owner, role: 'viewer' }),
      ).resolves.toEqual({
        status: 403,
        body: {
          statusCode: 403,
          error: 'Forbidden',
          message: 'Owner or admin role is required to create an order.',
          code: 'MANUAL_ORDER_ROLE_REQUIRED',
        },
      });
      expect(integrations.findActiveByOrg).not.toHaveBeenCalled();
    });

    it.each([
      [[], 'MANUAL_ORDER_SOURCE_UNAVAILABLE'],
      [
        [standalone, { ...standalone, id: 'int-2' }],
        'MANUAL_ORDER_SOURCE_AMBIGUOUS',
      ],
      [[{ ...standalone, orgId: 'org-2' }], 'MANUAL_ORDER_SOURCE_UNAVAILABLE'],
    ])('answers 409 for %j active sources', async (sources, code) => {
      integrations.findActiveByOrg.mockResolvedValue(sources);
      await expect(denial(MANUAL_ORDER_SOURCE_CODES)).resolves.toEqual({
        status: 409,
        body: {
          statusCode: 409,
          error: 'Conflict',
          message: 'Exactly one active commerce source is required.',
          code,
        },
      });
    });

    it('refuses a Shopify source', async () => {
      integrations.findActiveByOrg.mockResolvedValue([
        { ...standalone, platformType: 'shopify' },
      ]);
      await expect(denial(MANUAL_ORDER_SOURCE_CODES)).resolves.toEqual({
        status: 403,
        body: {
          statusCode: 403,
          error: 'Forbidden',
          message: 'Manual order creation is available only for Standalone.',
          code: 'MANUAL_ORDER_SOURCE_UNSUPPORTED',
        },
      });
    });

    it('refuses a source whose onboarding is pending', async () => {
      integrations.findActiveByOrg.mockResolvedValue([
        { ...standalone, onboardingStatus: 'pending' },
      ]);
      await expect(denial(MANUAL_ORDER_SOURCE_CODES)).resolves.toEqual({
        status: 409,
        body: {
          statusCode: 409,
          error: 'Conflict',
          message: 'Complete Standalone setup before creating an order.',
          code: 'MANUAL_ORDER_SETUP_INCOMPLETE',
        },
      });
    });
  });

  describe('import code map', () => {
    it.each([
      [
        'a viewer',
        { role: 'viewer' },
        [standalone],
        403,
        'IMPORT_ROLE_REQUIRED',
      ],
      ['no source', {}, [], 409, 'IMPORT_SOURCE_UNSUPPORTED'],
      [
        'two sources',
        {},
        [standalone, { ...standalone, id: 'int-2' }],
        409,
        'IMPORT_SOURCE_UNSUPPORTED',
      ],
      [
        'a Shopify source',
        {},
        [{ ...standalone, platformType: 'shopify' }],
        403,
        'IMPORT_SOURCE_UNSUPPORTED',
      ],
      [
        'pending onboarding',
        {},
        [{ ...standalone, onboardingStatus: 'pending' }],
        409,
        'IMPORT_SETUP_INCOMPLETE',
      ],
    ])('denies %s', async (_label, userPatch, sources, status, code) => {
      integrations.findActiveByOrg.mockResolvedValue(sources);
      const result = await denial(IMPORT_SOURCE_CODES, {
        ...owner,
        ...(userPatch as Partial<AuthenticatedUser>),
      });
      expect(result.status).toBe(status);
      expect(result.body).toMatchObject({ statusCode: status, code });
    });
  });
});
