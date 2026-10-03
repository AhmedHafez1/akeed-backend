import { HttpException, Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type {
  EasyOrdersConnectionsRepository,
  EasyOrdersPendingInstall,
} from '../../database/repositories/easyorders-connections.repository';
import type { AuthenticatedUser } from '../../../modules/auth/guards/dual-auth.guard';
import {
  EASYORDERS_CONFIG,
  type EasyOrdersConfig,
} from '../../../shared/config/easyorders.config';
import type { EasyOrdersApiClient } from './easyorders-api.client';
import {
  EASYORDERS_INSTALL_TTL_MS,
  EasyOrdersAuthService,
  parseInstallCallbackBody,
} from './easyorders-auth.service';
import {
  generateInstallToken,
  hashInstallToken,
} from './easyorders-install-token';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-03T10:00:00.000Z');

const owner: AuthenticatedUser = {
  userId: 'user-1',
  orgId: ORG_ID,
  role: 'owner',
  source: 'supabase',
};

function pendingInstall(
  overrides: Partial<EasyOrdersPendingInstall> = {},
): EasyOrdersPendingInstall {
  return {
    id: 'pending-1',
    orgId: ORG_ID,
    createdBy: 'user-1',
    callbackTokenHash: 'c'.repeat(64),
    webhookTokenHash: 'w'.repeat(64),
    webhookTokenHint: 'abc123',
    expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    consumedAt: null,
    supersededAt: null,
    attempts: 0,
    lastErrorCode: null,
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

function createService(settings: Partial<EasyOrdersConfig> = {}) {
  const config: EasyOrdersConfig = {
    enabled: true,
    pilotOrgIds: [ORG_ID],
    publicApiBaseUrl: 'https://api.akeed.test',
    appBaseUrl: 'https://app.akeed.test',
    ...settings,
  };
  const connections = {
    createPendingInstall: jest.fn(),
    findPendingByCallbackTokenHash: jest.fn(),
    recordFailedAttempt: jest.fn().mockResolvedValue(undefined),
    isStoreVerifiedForAnotherOrganization: jest.fn().mockResolvedValue(false),
    connect: jest.fn(),
    getOverview: jest.fn(),
    saveWebhookSecrets: jest.fn(),
  };
  const api = { probeKey: jest.fn() };
  const configService = {
    get: (key: string) => (key === EASYORDERS_CONFIG ? config : undefined),
    getOrThrow: () => 'k'.repeat(32),
  };
  const service = new EasyOrdersAuthService(
    connections as unknown as EasyOrdersConnectionsRepository,
    api as unknown as EasyOrdersApiClient,
    configService as unknown as ConfigService,
  );
  return { service, connections, api };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    return (error.getResponse() as { code?: string }).code;
  }
}

describe('EasyOrdersAuthService', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('startInstall', () => {
    it('stores only hashes, expires in 15 minutes and binds the context to the caller', async () => {
      const { service, connections } = createService();
      connections.createPendingInstall.mockImplementation(
        (input: { expiresAt: string }) =>
          Promise.resolve({
            kind: 'created',
            pending: pendingInstall({ expiresAt: input.expiresAt }),
          }),
      );

      const started = await service.startInstall(owner, { locale: 'en' });

      const params = new URLSearchParams(started.installUrl.split('?')[1]);
      const callbackToken = params.get('callback_url')!.split('/').pop()!;
      const webhookToken = params.get('orders_webhook')!.split('/').pop()!;
      expect(connections.createPendingInstall).toHaveBeenCalledWith({
        orgId: ORG_ID,
        createdBy: 'user-1',
        callbackTokenHash: hashInstallToken(callbackToken),
        webhookTokenHash: hashInstallToken(webhookToken),
        webhookTokenHint: webhookToken.slice(-6),
        expiresAt: new Date(
          NOW.getTime() + EASYORDERS_INSTALL_TTL_MS,
        ).toISOString(),
      });
      expect(EASYORDERS_INSTALL_TTL_MS).toBe(15 * 60 * 1000);
      expect(
        JSON.stringify(connections.createPendingInstall.mock.calls),
      ).not.toContain(callbackToken);
      expect(started.expiresAt).toBe(
        new Date(NOW.getTime() + EASYORDERS_INSTALL_TTL_MS).toISOString(),
      );
    });

    it.each([
      [{ ...owner, role: 'viewer' as const }, {}, 'EASYORDERS_ROLE_REQUIRED'],
      [
        { ...owner, source: 'shopify' as const },
        {},
        'EASYORDERS_SESSION_REQUIRED',
      ],
      [owner, { enabled: false }, 'EASYORDERS_CONNECT_UNAVAILABLE'],
      [owner, { pilotOrgIds: [] }, 'EASYORDERS_PILOT_REQUIRED'],
    ])('refuses with %#: %s', async (user, settings, code) => {
      const { service, connections } = createService(settings);

      await expect(
        codeOf(service.startInstall(user, { locale: 'ar' })),
      ).resolves.toBe(code);
      expect(connections.createPendingInstall).not.toHaveBeenCalled();
    });

    it('refuses an organization that already has a source', async () => {
      const { service, connections } = createService();
      connections.createPendingInstall.mockResolvedValue({
        kind: 'source_exists',
      });

      await expect(
        codeOf(service.startInstall(owner, { locale: 'ar' })),
      ).resolves.toBe('EASYORDERS_SOURCE_EXISTS');
    });
  });

  describe('handleCallback', () => {
    const token = generateInstallToken();
    const body = { api_key: 'key-under-test', store_id: 'store-1' };

    it('checks the key with EasyOrders before storing, and stores it encrypted', async () => {
      const { service, connections, api } = createService();
      connections.findPendingByCallbackTokenHash.mockResolvedValue(
        pendingInstall(),
      );
      api.probeKey.mockResolvedValue('live');
      connections.connect.mockResolvedValue({
        kind: 'connected',
        orgId: ORG_ID,
        integrationId: 'integration-1',
      });

      await expect(
        service.handleCallback(token, body),
      ).resolves.toBeUndefined();

      expect(connections.findPendingByCallbackTokenHash).toHaveBeenCalledWith(
        hashInstallToken(token),
      );
      expect(api.probeKey).toHaveBeenCalledWith('key-under-test');
      const [input] = connections.connect.mock.calls[0] as [
        { apiKeyEncrypted: string; storeId: string; health: string },
      ];
      expect(input).toMatchObject({
        pendingInstallId: 'pending-1',
        storeId: 'store-1',
        health: 'ok',
      });
      expect(input.apiKeyEncrypted).toMatch(/^v1:/);
      expect(input.apiKeyEncrypted).not.toContain('key-under-test');
      expect(api.probeKey.mock.invocationCallOrder[0]).toBeLessThan(
        connections.connect.mock.invocationCallOrder[0],
      );
    });

    it.each([
      ['a consumed', { consumedAt: NOW.toISOString() }],
      ['a superseded', { supersededAt: NOW.toISOString() }],
      ['an expired', { expiresAt: NOW.toISOString() }],
      ['an exhausted', { attempts: 5 }],
    ])(
      'answers %s context like an unknown one, without probing',
      async (_label, overrides) => {
        const { service, connections, api } = createService();
        connections.findPendingByCallbackTokenHash.mockResolvedValue(
          pendingInstall(overrides),
        );

        await expect(codeOf(service.handleCallback(token, body))).resolves.toBe(
          'EASYORDERS_INSTALL_CONTEXT_INVALID',
        );
        expect(api.probeKey).not.toHaveBeenCalled();
        expect(connections.connect).not.toHaveBeenCalled();
      },
    );

    it('never looks up a malformed token', async () => {
      const { service, connections } = createService();

      await expect(
        codeOf(service.handleCallback("x' OR 1=1 --", body)),
      ).resolves.toBe('EASYORDERS_INSTALL_CONTEXT_INVALID');
      expect(connections.findPendingByCallbackTokenHash).not.toHaveBeenCalled();
    });

    it.each([
      ['rejected', 'EASYORDERS_KEY_REJECTED'],
      ['unavailable', 'EASYORDERS_PROVIDER_UNAVAILABLE'],
    ])('stores nothing when the probe is %s', async (probe, code) => {
      const { service, connections, api } = createService();
      connections.findPendingByCallbackTokenHash.mockResolvedValue(
        pendingInstall(),
      );
      api.probeKey.mockResolvedValue(probe);

      await expect(codeOf(service.handleCallback(token, body))).resolves.toBe(
        code,
      );
      expect(connections.connect).not.toHaveBeenCalled();
      expect(connections.recordFailedAttempt).toHaveBeenCalledWith(
        'pending-1',
        code,
      );
    });

    it('does not send the key to EasyOrders for a store verified elsewhere', async () => {
      const { service, connections, api } = createService();
      connections.findPendingByCallbackTokenHash.mockResolvedValue(
        pendingInstall(),
      );
      connections.isStoreVerifiedForAnotherOrganization.mockResolvedValue(true);

      await expect(codeOf(service.handleCallback(token, body))).resolves.toBe(
        'EASYORDERS_STORE_UNAVAILABLE',
      );
      expect(api.probeKey).not.toHaveBeenCalled();
    });

    it('never writes the key, the token or the store into a log line', async () => {
      const lines: string[] = [];
      for (const level of ['log', 'warn', 'error'] as const)
        jest
          .spyOn(Logger.prototype, level)
          .mockImplementation((...args: unknown[]) => {
            lines.push(String(args[0]));
          });
      const { service, connections, api } = createService();
      connections.findPendingByCallbackTokenHash.mockResolvedValue(
        pendingInstall(),
      );
      api.probeKey.mockResolvedValueOnce('rejected').mockResolvedValue('live');
      connections.connect.mockResolvedValue({
        kind: 'connected',
        orgId: ORG_ID,
        integrationId: 'integration-1',
      });

      await codeOf(service.handleCallback(token, body));
      await service.handleCallback(token, body);
      await codeOf(service.handleCallback(generateInstallToken(), body));

      expect(lines.length).toBeGreaterThanOrEqual(3);
      const logged = lines.join('\n');
      expect(logged).not.toContain('key-under-test');
      expect(logged).not.toContain(token);
      expect(logged).not.toContain(hashInstallToken(token));
    });
  });

  describe('parseInstallCallbackBody', () => {
    it('reads the two documented fields and ignores anything else', () => {
      expect(
        parseInstallCallbackBody({
          api_key: 'k',
          store_id: 's',
          secret: 'ignored',
        }),
      ).toEqual({ apiKey: 'k', storeId: 's' });
    });

    it.each([
      null,
      'text',
      [],
      {},
      { api_key: '', store_id: 's' },
      { api_key: 'k', store_id: '' },
      { api_key: 'k\n', store_id: 's' },
      { api_key: 'k'.repeat(513), store_id: 's' },
      { api_key: 'k', store_id: { id: 's' } },
    ])('rejects %p', (value) => {
      expect(parseInstallCallbackBody(value)).toBeNull();
    });
  });

  describe('getStatus', () => {
    it('reports a connection without any credential, hash or token', async () => {
      const { service, connections } = createService();
      connections.getOverview.mockResolvedValue({
        organizationName: 'Noor Store',
        sourcePlatforms: ['easyorders'],
        latestPending: pendingInstall({ consumedAt: NOW.toISOString() }),
        connection: {
          integrationId: 'integration-1',
          orgId: ORG_ID,
          storeId: 'store-1',
          storeVerifiedAt: null,
          apiKeyEncrypted: 'v1:ciphertext-key',
          webhookTokenHash: 'h'.repeat(64),
          webhookTokenHint: 'abc123',
          ordersWebhookSecretEncrypted: 'v1:ciphertext-orders',
          statusWebhookSecretEncrypted: null,
          health: 'store_inactive',
          connectedBy: 'user-1',
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
        },
      });

      const status = await service.getStatus({ ...owner, role: 'viewer' });

      expect(status).toEqual({
        state: 'connected',
        canManage: false,
        organizationName: 'Noor Store',
        expiresAt: null,
        lastErrorCode: null,
        connection: {
          storeId: 'store-1',
          storeVerified: false,
          health: 'store_inactive',
          webhookUrlHint: 'abc123',
          ordersSecretSet: true,
          statusSecretSet: false,
          connectedAt: NOW.toISOString(),
        },
      });
      const serialized = JSON.stringify(status);
      expect(serialized).not.toContain('ciphertext');
      expect(serialized).not.toContain('h'.repeat(64));
    });
  });
});
