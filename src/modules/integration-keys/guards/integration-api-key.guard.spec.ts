import { HttpException, Logger, type ExecutionContext } from '@nestjs/common';
import type {
  IntegrationApiKeyCredential,
  IntegrationApiKeysRepository,
} from '../../../infrastructure/database/repositories/integration-api-keys.repository';
import { generateIntegrationApiKey } from '../integration-api-key.secret';
import type { RequestWithIntegrationApiKey } from '../integration-api-key.principal';
import {
  IntegrationApiKeyGuard,
  LAST_USED_WRITE_INTERVAL_MS,
} from './integration-api-key.guard';

const ORG = '11111111-1111-4111-8111-111111111111';
const SOURCE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const issued = generateIntegrationApiKey();
const other = generateIntegrationApiKey();

function credential(
  overrides: Partial<IntegrationApiKeyCredential> = {},
): IntegrationApiKeyCredential {
  return {
    id: KEY_ID,
    orgId: ORG,
    integrationId: SOURCE,
    prefix: issued.prefix,
    keyHash: issued.keyHash,
    lastUsedAt: new Date().toISOString(),
    revokedAt: null,
    ...overrides,
  };
}

function setup(row: IntegrationApiKeyCredential | null = credential()) {
  const keys = {
    findByPrefixForAuthentication: jest.fn().mockResolvedValue(row),
    touchLastUsed: jest.fn().mockResolvedValue(undefined),
  };
  const guard = new IntegrationApiKeyGuard(
    keys as unknown as IntegrationApiKeysRepository,
  );
  return { guard, keys };
}

function request(
  headers: Record<string, string | string[] | undefined> = {},
  query: Record<string, unknown> = {},
): RequestWithIntegrationApiKey {
  return { headers, query } as unknown as RequestWithIntegrationApiKey;
}

function contextFor(req: RequestWithIntegrationApiKey): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

async function rejection(
  guard: IntegrationApiKeyGuard,
  req: RequestWithIntegrationApiKey,
): Promise<{ status: number; body: unknown }> {
  try {
    await guard.canActivate(contextFor(req));
  } catch (error) {
    if (error instanceof HttpException)
      return { status: error.getStatus(), body: error.getResponse() };
    throw error;
  }
  throw new Error('expected the guard to refuse');
}

const UNIFORM_401 = {
  status: 401,
  body: {
    statusCode: 401,
    error: 'Unauthorized',
    message: 'A valid API key is required.',
    code: 'API_KEY_INVALID',
  },
};

describe('IntegrationApiKeyGuard', () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    for (const level of ['log', 'warn', 'error'] as const)
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => {
          logs.push(String(args[0]));
        });
  });

  afterEach(() => jest.restoreAllMocks());

  it('attaches the principal for a valid bearer key', async () => {
    const { guard } = setup();
    const req = request({ authorization: `Bearer ${issued.plaintext}` });

    await expect(guard.canActivate(contextFor(req))).resolves.toBe(true);

    expect(req.integrationApiKey).toEqual({
      orgId: ORG,
      integrationId: SOURCE,
      keyId: KEY_ID,
      prefix: issued.prefix,
    });
  });

  it.each([
    ['no header', {}],
    ['an empty header', { authorization: '' }],
    ['a Basic header', { authorization: `Basic ${issued.plaintext}` }],
    ['a lowercase scheme', { authorization: `bearer ${issued.plaintext}` }],
    ['a bare key', { authorization: issued.plaintext }],
    ['two spaces', { authorization: `Bearer  ${issued.plaintext}` }],
    ['a trailing token', { authorization: `Bearer ${issued.plaintext} x` }],
    ['a malformed key', { authorization: 'Bearer ak_live_nope' }],
    ['a session JWT', { authorization: 'Bearer eyJhbGciOi.eyJzdWIi.c2ln' }],
  ])('answers the uniform 401 for %s', async (_name, headers) => {
    const { guard, keys } = setup();

    await expect(rejection(guard, request(headers))).resolves.toEqual(
      UNIFORM_401,
    );
    expect(keys.findByPrefixForAuthentication).not.toHaveBeenCalled();
  });

  it('answers the uniform 401 for an unknown prefix', async () => {
    const { guard, keys } = setup(null);

    await expect(
      rejection(
        guard,
        request({ authorization: `Bearer ${issued.plaintext}` }),
      ),
    ).resolves.toEqual(UNIFORM_401);
    expect(keys.findByPrefixForAuthentication).toHaveBeenCalledWith(
      issued.prefix,
    );
  });

  it('answers the uniform 401 for a wrong secret under a real prefix', async () => {
    const { guard } = setup();
    const forged = `${issued.prefix}_${other.plaintext.slice(17)}`;

    await expect(
      rejection(guard, request({ authorization: `Bearer ${forged}` })),
    ).resolves.toEqual(UNIFORM_401);
  });

  it('answers the uniform 401 for a revoked key', async () => {
    const { guard, keys } = setup(
      credential({ revokedAt: '2026-10-02T11:00:00.000Z' }),
    );

    await expect(
      rejection(
        guard,
        request({ authorization: `Bearer ${issued.plaintext}` }),
      ),
    ).resolves.toEqual(UNIFORM_401);
    expect(keys.touchLastUsed).not.toHaveBeenCalled();
  });

  it.each([
    ['api_key', { api_key: issued.plaintext }],
    ['apiKey', { apiKey: 'anything' }],
    ['access_token', { access_token: 'anything' }],
    ['token', { token: 'anything' }],
    ['a key under another name', { q: issued.plaintext }],
    ['a key in an array', { q: ['x', issued.plaintext] }],
    ['a key in a nested value', { filter: { k: issued.plaintext } }],
  ])(
    'refuses a key in the query string (%s) even with a valid header',
    async (_name, query) => {
      const { guard, keys } = setup();
      const req = request(
        { authorization: `Bearer ${issued.plaintext}` },
        query,
      );

      await expect(rejection(guard, req)).resolves.toEqual(UNIFORM_401);
      expect(keys.findByPrefixForAuthentication).not.toHaveBeenCalled();
      expect(req.integrationApiKey).toBeUndefined();
    },
  );

  it('lets unrelated query parameters through', async () => {
    const { guard } = setup();

    await expect(
      guard.canActivate(
        contextFor(
          request(
            { authorization: `Bearer ${issued.plaintext}` },
            { page: '2' },
          ),
        ),
      ),
    ).resolves.toBe(true);
  });

  describe('last_used_at', () => {
    it('is not written again within a minute', async () => {
      const { guard, keys } = setup(
        credential({
          lastUsedAt: new Date(
            Date.now() - LAST_USED_WRITE_INTERVAL_MS / 2,
          ).toISOString(),
        }),
      );

      await guard.canActivate(
        contextFor(request({ authorization: `Bearer ${issued.plaintext}` })),
      );

      expect(keys.touchLastUsed).not.toHaveBeenCalled();
    });

    it.each([
      ['never used', null],
      [
        'used over a minute ago',
        new Date(Date.now() - 2 * LAST_USED_WRITE_INTERVAL_MS).toISOString(),
      ],
    ])('is written when the key was %s', async (_name, lastUsedAt) => {
      const { guard, keys } = setup(credential({ lastUsedAt }));

      await guard.canActivate(
        contextFor(request({ authorization: `Bearer ${issued.plaintext}` })),
      );

      expect(keys.touchLastUsed).toHaveBeenCalledWith(KEY_ID);
    });

    it('never fails an authenticated request when the write fails', async () => {
      const { guard, keys } = setup(credential({ lastUsedAt: null }));
      keys.touchLastUsed.mockRejectedValueOnce(new Error('db down'));

      await expect(
        guard.canActivate(
          contextFor(request({ authorization: `Bearer ${issued.plaintext}` })),
        ),
      ).resolves.toBe(true);
      expect(
        logs.some((line) => line.includes('integration-api-key-touch')),
      ).toBe(true);
    });
  });

  it('logs the reason and prefix, never the key or the hash', async () => {
    const revoked = setup(
      credential({ revokedAt: '2026-10-02T11:00:00.000Z' }),
    );
    await rejection(
      revoked.guard,
      request({ authorization: `Bearer ${issued.plaintext}` }),
    );
    await rejection(
      setup().guard,
      request(
        { authorization: `Bearer ${issued.plaintext}` },
        { api_key: issued.plaintext },
      ),
    );

    const entries = logs.map((line) => JSON.parse(line) as object);
    expect(entries).toContainEqual(
      expect.objectContaining({
        action: 'integration-api-key-authenticate',
        outcome: 'failure',
        errorCode: 'revoked',
        keyPrefix: issued.prefix,
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ errorCode: 'query_string' }),
    );
    const joined = logs.join('\n');
    expect(joined).not.toContain(issued.plaintext);
    expect(joined).not.toContain(issued.plaintext.slice(17));
    expect(joined).not.toContain(issued.keyHash);
  });
});
