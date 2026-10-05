import { HttpException, Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type {
  EasyOrdersConnection,
  EasyOrdersConnectionsRepository,
  EasyOrdersPendingInstall,
} from '../../database/repositories/easyorders-connections.repository';
import type { CommerceOutcomeSyncsRepository } from '../../database/repositories/commerce-outcome-syncs.repository';
import type { AuthenticatedUser } from '../../../modules/auth/guards/dual-auth.guard';
import {
  EASYORDERS_CONFIG,
  type EasyOrdersConfig,
} from '../../../shared/config/easyorders.config';
import { PhoneService } from '../../../shared/services/phone.service';
import type { EasyOrdersApiClient } from './easyorders-api.client';
import {
  EASYORDERS_INSTALL_TTL_MS,
  EasyOrdersAuthService,
  parseInstallCallbackBody,
} from './easyorders-auth.service';
import {
  generateInstallToken,
  hashInstallToken,
} from '../../../shared/commerce/install-token';

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

function connectionRow(
  overrides: Partial<EasyOrdersConnection> = {},
): EasyOrdersConnection {
  return {
    integrationId: 'integration-1',
    orgId: ORG_ID,
    storeId: 'store-1',
    storeVerifiedAt: null,
    apiKeyEncrypted: 'v1:ciphertext-key',
    webhookTokenHash: 'h'.repeat(64),
    webhookTokenHint: 'abc123',
    ordersWebhookSecretEncrypted: 'v1:ciphertext-orders',
    statusWebhookSecretEncrypted: null,
    disconnectedAt: null,
    disconnectedBy: null,
    health: 'store_inactive',
    currency: 'EGP',
    phoneCountry: null,
    rejectedDeliveries: 3,
    lastRejectedAt: NOW.toISOString(),
    connectedBy: 'user-1',
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

/** What a disconnect leaves on the row: the store and settings, no credential. */
function disconnectedRow(): EasyOrdersConnection {
  return connectionRow({
    apiKeyEncrypted: null,
    webhookTokenHash: null,
    webhookTokenHint: null,
    ordersWebhookSecretEncrypted: null,
    disconnectedAt: NOW.toISOString(),
    disconnectedBy: 'user-1',
    health: 'ok',
    rejectedDeliveries: 0,
    lastRejectedAt: null,
  });
}

function createService(settings: Partial<EasyOrdersConfig> = {}) {
  const config: EasyOrdersConfig = {
    enabled: true,
    ingestionEnabled: false,
    outcomeSyncEnabled: false,
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
    saveOrderSettings: jest.fn(),
    disconnect: jest.fn(),
  };
  const outcomeSyncs = {
    failPendingForIntegration: jest.fn().mockResolvedValue(0),
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
    new PhoneService(),
    outcomeSyncs as unknown as CommerceOutcomeSyncsRepository,
  );
  return { service, connections, api, outcomeSyncs };
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
      [
        owner,
        { pilotOrgIds: ['33333333-3333-4333-8333-333333333333'] },
        'EASYORDERS_PILOT_REQUIRED',
      ],
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

    it('refuses a reconnect that names another store, and counts the attempt', async () => {
      const { service, connections, api } = createService();
      connections.findPendingByCallbackTokenHash.mockResolvedValue(
        pendingInstall(),
      );
      api.probeKey.mockResolvedValue('live');
      connections.connect.mockResolvedValue({
        kind: 'store_mismatch',
        orgId: ORG_ID,
      });

      await expect(codeOf(service.handleCallback(token, body))).resolves.toBe(
        'EASYORDERS_RECONNECT_STORE_MISMATCH',
      );
      expect(connections.recordFailedAttempt).toHaveBeenCalledWith(
        'pending-1',
        'EASYORDERS_RECONNECT_STORE_MISMATCH',
      );
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

  describe('saveOrderSettings', () => {
    it('stores the currency and phone country in canonical form', async () => {
      const { service, connections } = createService();
      connections.saveOrderSettings.mockResolvedValue(true);
      connections.getOverview.mockResolvedValue({
        organizationName: 'Noor Store',
        sourcePlatforms: ['easyorders'],
        latestPending: undefined,
        connection: undefined,
      });

      await service.saveOrderSettings(owner, {
        currency: 'egp',
        phoneCountry: 'eg',
      });

      expect(connections.saveOrderSettings).toHaveBeenCalledWith(ORG_ID, {
        currency: 'EGP',
        phoneCountry: 'EG',
      });
    });

    it.each([
      [{ currency: 'XXX', phoneCountry: 'EG' }, ['currency']],
      [{ currency: 'EGP', phoneCountry: 'ZZ' }, ['phoneCountry']],
      [{ currency: 'XXX', phoneCountry: 'ZZ' }, ['currency', 'phoneCountry']],
    ])(
      'refuses unsupported values %j without storing',
      async (input, fields) => {
        const { service, connections } = createService();

        const error = await service
          .saveOrderSettings(owner, input)
          .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).getResponse()).toMatchObject({
          code: 'EASYORDERS_ORDER_SETTINGS_INVALID',
          fields,
        });
        expect(connections.saveOrderSettings).not.toHaveBeenCalled();
      },
    );

    it('is refused for a viewer and for an organization without a connection', async () => {
      const { service, connections } = createService();
      const input = { currency: 'EGP', phoneCountry: 'EG' };

      expect(
        await codeOf(
          service.saveOrderSettings({ ...owner, role: 'viewer' }, input),
        ),
      ).toBe('EASYORDERS_ROLE_REQUIRED');
      expect(connections.saveOrderSettings).not.toHaveBeenCalled();

      connections.saveOrderSettings.mockResolvedValue(false);
      expect(await codeOf(service.saveOrderSettings(owner, input))).toBe(
        'EASYORDERS_NOT_CONNECTED',
      );
    });
  });

  describe('disconnect', () => {
    const overview = {
      organizationName: 'Noor Store',
      sourcePlatforms: ['easyorders'],
      latestPending: undefined,
      connection: disconnectedRow(),
    };

    it('deactivates the source, closes waiting store updates and answers disconnected', async () => {
      const { service, connections, outcomeSyncs } = createService();
      connections.disconnect.mockResolvedValue({
        kind: 'disconnected',
        integrationId: 'integration-1',
        storeWasVerified: true,
      });
      connections.getOverview.mockResolvedValue(overview);

      const status = await service.disconnect(owner);

      expect(connections.disconnect).toHaveBeenCalledWith(ORG_ID, 'user-1');
      expect(outcomeSyncs.failPendingForIntegration).toHaveBeenCalledWith(
        ORG_ID,
        'integration-1',
        'integration_inactive',
      );
      expect(status.state).toBe('disconnected');
      expect(status.connection).toMatchObject({
        storeId: 'store-1',
        webhookUrlHint: null,
        ordersSecretSet: false,
        statusSecretSet: false,
        disconnectedAt: NOW.toISOString(),
      });
    });

    it('works with the connect switch off and off the pilot list', async () => {
      const { service, connections } = createService({
        enabled: false,
        pilotOrgIds: [],
      });
      connections.disconnect.mockResolvedValue({
        kind: 'disconnected',
        integrationId: 'integration-1',
        storeWasVerified: false,
      });
      connections.getOverview.mockResolvedValue(overview);

      await expect(service.disconnect(owner)).resolves.toMatchObject({
        state: 'disconnected',
      });
    });

    it('is a no-op the second time', async () => {
      const { service, connections, outcomeSyncs } = createService();
      connections.disconnect.mockResolvedValue({
        kind: 'already_disconnected',
        integrationId: 'integration-1',
      });
      connections.getOverview.mockResolvedValue(overview);

      await expect(service.disconnect(owner)).resolves.toMatchObject({
        state: 'disconnected',
      });
      expect(outcomeSyncs.failPendingForIntegration).not.toHaveBeenCalled();
    });

    it('still disconnects when closing the waiting store updates fails', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const { service, connections, outcomeSyncs } = createService();
      connections.disconnect.mockResolvedValue({
        kind: 'disconnected',
        integrationId: 'integration-1',
        storeWasVerified: false,
      });
      outcomeSyncs.failPendingForIntegration.mockRejectedValue(
        new Error('database unavailable'),
      );
      connections.getOverview.mockResolvedValue(overview);

      await expect(service.disconnect(owner)).resolves.toMatchObject({
        state: 'disconnected',
      });
    });

    it('is refused for a viewer and for an organization without a connection', async () => {
      const { service, connections } = createService();

      expect(
        await codeOf(service.disconnect({ ...owner, role: 'viewer' })),
      ).toBe('EASYORDERS_ROLE_REQUIRED');
      expect(connections.disconnect).not.toHaveBeenCalled();

      connections.disconnect.mockResolvedValue({ kind: 'not_connected' });
      expect(await codeOf(service.disconnect(owner))).toBe(
        'EASYORDERS_NOT_CONNECTED',
      );
    });
  });

  describe('getStatus', () => {
    it.each([
      ['no reconnect opened', undefined, 'disconnected', null],
      [
        'an install retired by the disconnect',
        pendingInstall({ supersededAt: NOW.toISOString() }),
        'disconnected',
        null,
      ],
      ['a reconnect waiting', pendingInstall(), 'pending', null],
      [
        'a refused reconnect',
        pendingInstall({
          lastErrorCode: 'EASYORDERS_RECONNECT_STORE_MISMATCH',
        }),
        'failed',
        'EASYORDERS_RECONNECT_STORE_MISMATCH',
      ],
      [
        'an expired reconnect',
        pendingInstall({ expiresAt: NOW.toISOString() }),
        'expired',
        null,
      ],
    ])(
      'reports a disconnected source with %s, even with the switch off',
      async (_label, latestPending, state, lastErrorCode) => {
        const { service, connections } = createService({ enabled: false });
        connections.getOverview.mockResolvedValue({
          organizationName: 'Noor Store',
          sourcePlatforms: ['easyorders'],
          latestPending,
          connection: disconnectedRow(),
        });

        const status = await service.getStatus(owner);

        expect(status).toMatchObject({ state, lastErrorCode });
        expect(status.connection).toMatchObject({
          storeId: 'store-1',
          disconnectedAt: NOW.toISOString(),
        });
      },
    );

    it('reports a connection without any credential, hash or token', async () => {
      const { service, connections } = createService();
      connections.getOverview.mockResolvedValue({
        organizationName: 'Noor Store',
        sourcePlatforms: ['easyorders'],
        latestPending: pendingInstall({ consumedAt: NOW.toISOString() }),
        connection: connectionRow(),
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
          currency: 'EGP',
          phoneCountry: null,
          rejectedDeliveries: 3,
          connectedAt: NOW.toISOString(),
          disconnectedAt: null,
        },
      });
      const serialized = JSON.stringify(status);
      expect(serialized).not.toContain('ciphertext');
      expect(serialized).not.toContain('h'.repeat(64));
    });
  });
});
