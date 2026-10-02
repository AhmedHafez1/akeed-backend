import { ConflictException, Logger } from '@nestjs/common';
import {
  IntegrationApiKeyPrefixTakenError,
  type IntegrationApiKeyMetadata,
  type IntegrationApiKeysRepository,
} from '../../infrastructure/database/repositories/integration-api-keys.repository';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { assertOrganizationWriteAllowed } from '../auth/organization-role';
import type { StandaloneOrderIngestionService } from '../order-ingestion/standalone-order-ingestion.service';
import { API_KEY_SOURCE_CODES } from '../order-ingestion/standalone-source-resolver';
import {
  IntegrationKeysService,
  MAX_ACTIVE_INTEGRATION_API_KEYS,
} from './integration-keys.service';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const SOURCE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function user(
  role: AuthenticatedUser['role'],
  orgId = ORG_A,
): AuthenticatedUser {
  return { userId: `${role}-user`, orgId, role, source: 'supabase' };
}

function metadata(
  overrides: Partial<IntegrationApiKeyMetadata> = {},
): IntegrationApiKeyMetadata {
  return {
    id: KEY_ID,
    orgId: ORG_A,
    integrationId: SOURCE_A,
    prefix: 'ak_live_abcd1234',
    name: 'Shop server',
    createdBy: 'owner-user',
    createdAt: '2026-10-02T10:00:00.000Z',
    lastUsedAt: null,
    revokedAt: null,
    revokedBy: null,
    ...overrides,
  };
}

function setup() {
  const keys = {
    listByOrg: jest.fn().mockResolvedValue([]),
    createWithinCap: jest.fn<
      Promise<unknown>,
      [key: Record<string, string>, maxActive: number]
    >((key) =>
      Promise.resolve({
        kind: 'created',
        key: metadata({ prefix: key.prefix, name: key.name }),
      }),
    ),
    revoke: jest.fn(),
  };
  // The real role rule and code map; the source is whatever the org resolves to.
  const ingestion = {
    assertWritableRole: jest.fn(
      (caller: AuthenticatedUser, codes: typeof API_KEY_SOURCE_CODES) =>
        assertOrganizationWriteAllowed(caller.role, codes.roleRequired),
    ),
    resolveWritableSource: jest.fn(
      (caller: AuthenticatedUser, codes: typeof API_KEY_SOURCE_CODES) => {
        assertOrganizationWriteAllowed(caller.role, codes.roleRequired);
        return Promise.resolve({ id: SOURCE_A, orgId: caller.orgId });
      },
    ),
  };
  const service = new IntegrationKeysService(
    keys as unknown as IntegrationApiKeysRepository,
    ingestion as unknown as StandaloneOrderIngestionService,
  );
  return { service, keys, ingestion };
}

describe('IntegrationKeysService', () => {
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

  describe('create', () => {
    it.each(['owner', 'admin'] as const)(
      'lets an %s create a key for the resolved source and returns the secret once',
      async (role) => {
        const { service, keys, ingestion } = setup();

        const created = await service.create(user(role), {
          name: 'Shop server',
        });

        expect(ingestion.resolveWritableSource).toHaveBeenCalledWith(
          user(role),
          API_KEY_SOURCE_CODES,
        );
        const [stored, cap] = keys.createWithinCap.mock.calls[0];
        expect(cap).toBe(MAX_ACTIVE_INTEGRATION_API_KEYS);
        const { prefix, keyHash, ...rest } = stored;
        expect(prefix).toMatch(/^ak_live_[a-z0-9]{8}$/);
        expect(keyHash).toMatch(/^[0-9a-f]{64}$/);
        expect(rest).toEqual({
          orgId: ORG_A,
          integrationId: SOURCE_A,
          name: 'Shop server',
          createdBy: `${role}-user`,
        });
        expect(created.secret.startsWith(`${stored.prefix}_`)).toBe(true);
        expect(created.key).toEqual({
          id: KEY_ID,
          name: 'Shop server',
          prefix: stored.prefix,
          status: 'active',
          createdAt: '2026-10-02T10:00:00.000Z',
          lastUsedAt: null,
          revokedAt: null,
        });
        // What is stored never contains the secret.
        expect(JSON.stringify(stored)).not.toContain(
          created.secret.slice(stored.prefix.length + 1),
        );
      },
    );

    it('refuses a viewer before any key is generated or stored', async () => {
      const { service, keys } = setup();

      await expect(
        service.create(user('viewer'), { name: 'x' }),
      ).rejects.toMatchObject({
        status: 403,
        response: { code: 'API_KEY_ROLE_REQUIRED' },
      });
      expect(keys.createWithinCap).not.toHaveBeenCalled();
    });

    it('passes source denials through unchanged', async () => {
      const { service, keys, ingestion } = setup();
      ingestion.resolveWritableSource.mockRejectedValueOnce(
        new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          message: API_KEY_SOURCE_CODES.setupIncomplete.message,
          code: 'API_KEY_SETUP_INCOMPLETE',
        }),
      );

      await expect(
        service.create(user('owner'), { name: 'x' }),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'API_KEY_SETUP_INCOMPLETE' },
      });
      expect(keys.createWithinCap).not.toHaveBeenCalled();
    });

    it('answers 409 API_KEY_LIMIT_REACHED at the active-key cap', async () => {
      const { service, keys } = setup();
      keys.createWithinCap.mockResolvedValueOnce({ kind: 'limit_reached' });

      await expect(
        service.create(user('owner'), { name: 'x' }),
      ).rejects.toMatchObject({
        status: 409,
        response: {
          code: 'API_KEY_LIMIT_REACHED',
          maxActive: MAX_ACTIVE_INTEGRATION_API_KEYS,
        },
      });
    });

    it('draws a new prefix when the generated one is taken', async () => {
      const { service, keys } = setup();
      keys.createWithinCap.mockRejectedValueOnce(
        new IntegrationApiKeyPrefixTakenError(),
      );

      await service.create(user('owner'), { name: 'x' });

      expect(keys.createWithinCap).toHaveBeenCalledTimes(2);
      const prefixes = keys.createWithinCap.mock.calls.map(
        ([key]) => key.prefix,
      );
      expect(prefixes[0]).not.toBe(prefixes[1]);
    });

    it('gives up after repeated prefix collisions', async () => {
      const { service, keys } = setup();
      keys.createWithinCap.mockRejectedValue(
        new IntegrationApiKeyPrefixTakenError(),
      );

      await expect(
        service.create(user('owner'), { name: 'x' }),
      ).rejects.toBeInstanceOf(IntegrationApiKeyPrefixTakenError);
      expect(keys.createWithinCap).toHaveBeenCalledTimes(3);
    });

    it('audits the actor, action and prefix, never the secret or hash', async () => {
      const { service, keys } = setup();

      const created = await service.create(user('admin'), {
        name: 'Shop server',
      });

      const [stored] = keys.createWithinCap.mock.calls[0];
      const audit = logs.map((line) => JSON.parse(line) as object);
      expect(audit).toContainEqual(
        expect.objectContaining({
          action: 'integration-api-key-create',
          outcome: 'success',
          orgId: ORG_A,
          userId: 'admin-user',
          keyId: KEY_ID,
          keyPrefix: stored.prefix,
        }),
      );
      const joined = logs.join('\n');
      expect(joined).not.toContain(created.secret);
      expect(joined).not.toContain(
        created.secret.slice(stored.prefix.length + 1),
      );
      expect(joined).not.toContain(stored.keyHash);
    });
  });

  describe('list', () => {
    it('lets any member, viewers included, read metadata only', async () => {
      const { service, keys } = setup();
      keys.listByOrg.mockResolvedValueOnce([
        metadata(),
        metadata({
          id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          revokedAt: '2026-10-02T11:00:00.000Z',
          revokedBy: 'owner-user',
        }),
      ]);

      const listed = await service.list(user('viewer'));

      expect(keys.listByOrg).toHaveBeenCalledWith(ORG_A, 50);
      expect(listed.maxActive).toBe(MAX_ACTIVE_INTEGRATION_API_KEYS);
      expect(listed.keys.map((key) => key.status)).toEqual([
        'active',
        'revoked',
      ]);
      for (const key of listed.keys)
        expect(Object.keys(key).sort()).toEqual([
          'createdAt',
          'id',
          'lastUsedAt',
          'name',
          'prefix',
          'revokedAt',
          'status',
        ]);
      expect(JSON.stringify(listed)).not.toMatch(/hash|secret/i);
    });

    it("scopes the list to the caller's organization", async () => {
      const { service, keys } = setup();

      await service.list(user('owner', ORG_B));

      expect(keys.listByOrg).toHaveBeenCalledWith(ORG_B, 50);
    });
  });

  describe('revoke', () => {
    it.each(['owner', 'admin'] as const)(
      'lets an %s revoke a key without needing a ready source',
      async (role) => {
        const { service, keys, ingestion } = setup();
        keys.revoke.mockResolvedValueOnce({
          kind: 'revoked',
          key: metadata({ revokedAt: '2026-10-02T11:00:00.000Z' }),
        });

        const revoked = await service.revoke(user(role), KEY_ID);

        expect(keys.revoke).toHaveBeenCalledWith(ORG_A, KEY_ID, `${role}-user`);
        expect(ingestion.resolveWritableSource).not.toHaveBeenCalled();
        expect(revoked.status).toBe('revoked');
        expect(logs.map((line) => JSON.parse(line) as object)).toContainEqual(
          expect.objectContaining({
            action: 'integration-api-key-revoke',
            outcome: 'success',
            userId: `${role}-user`,
            keyPrefix: 'ak_live_abcd1234',
          }),
        );
      },
    );

    it('refuses a viewer before touching the key', async () => {
      const { service, keys } = setup();

      await expect(
        service.revoke(user('viewer'), KEY_ID),
      ).rejects.toMatchObject({
        status: 403,
        response: { code: 'API_KEY_ROLE_REQUIRED' },
      });
      expect(keys.revoke).not.toHaveBeenCalled();
    });

    it('is idempotent: an already revoked key answers its original revocation', async () => {
      const { service, keys } = setup();
      keys.revoke.mockResolvedValueOnce({
        kind: 'already_revoked',
        key: metadata({ revokedAt: '2026-10-02T11:00:00.000Z' }),
      });

      const revoked = await service.revoke(user('owner'), KEY_ID);

      expect(revoked.revokedAt).toBe('2026-10-02T11:00:00.000Z');
      expect(logs.map((line) => JSON.parse(line) as object)).toContainEqual(
        expect.objectContaining({
          action: 'integration-api-key-revoke',
          outcome: 'skipped',
          reason: 'already_revoked',
        }),
      );
    });

    it("answers 404 for an unknown key or another organization's key", async () => {
      const { service, keys } = setup();
      keys.revoke.mockResolvedValueOnce({ kind: 'not_found' });

      await expect(
        service.revoke(user('owner', ORG_B), KEY_ID),
      ).rejects.toMatchObject({
        status: 404,
        response: { code: 'API_KEY_NOT_FOUND' },
      });
      expect(keys.revoke).toHaveBeenCalledWith(ORG_B, KEY_ID, 'owner-user');
    });
  });
});
