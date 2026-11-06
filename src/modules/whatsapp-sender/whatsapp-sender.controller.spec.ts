import { SenderAlertService } from './sender-alert.service';
import {
  ValidationPipe,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { WhatsappConnectionSettingsService } from './whatsapp-connection-settings.service';
import { WhatsappConnectionsRepository } from '../../infrastructure/database/repositories/whatsapp-connections.repository';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  DualAuthGuard,
  type AuthenticatedUser,
} from '../auth/guards/dual-auth.guard';
import {
  parseWhatsappOwnNumberConfig,
  WHATSAPP_OWN_NUMBER_CONFIG,
} from '../../shared/config/whatsapp-own-number.config';
import { ConnectionStatusService } from './connection-status.service';
import { WhatsappConnectService } from './whatsapp-connect.service';
import { WhatsappSenderController } from './whatsapp-sender.controller';
import { WhatsappSenderService } from './whatsapp-sender.service';
import { WhatsappDisconnectService } from './whatsapp-disconnect.service';

const ROUTE = '/api/whatsapp-sender';
const ORG = '0b9f6f7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const OTHER_ORG = '5a4f3e2d-1c0b-4a9f-8e7d-6c5b4a3f2e1d';
const ENCRYPTION_KEY = 'k'.repeat(32);

const connectOn = {
  WHATSAPP_OWN_NUMBER_CONNECT_ENABLED: 'true',
  META_EMBEDDED_SIGNUP_CONFIG_ID: '1234567890',
  META_APP_ID: '9876543210',
  WHATSAPP_CONNECT_PAGE_BASE_URL: 'https://app.example.test',
  SHOPIFY_TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
};

const http = (app: INestApplication) =>
  request(app.getHttpServer() as Parameters<typeof request>[0]);

describe('/api/whatsapp-sender', () => {
  // Each case boots a Nest app, which can pass 5 s on a loaded full run.
  jest.setTimeout(30_000);

  let app: INestApplication | undefined;
  let user: AuthenticatedUser | null;
  const connect = { issueTicket: jest.fn() };
  const status = { forOrganization: jest.fn() };
  const senderAlerts = { read: jest.fn().mockResolvedValue([]) };
  const disconnect = { disconnect: jest.fn() };
  const connections = { updateThankYouEnabled: jest.fn() };

  async function start(env: Record<string, string>) {
    const parsed = parseWhatsappOwnNumberConfig(env);
    const module = await Test.createTestingModule({
      controllers: [WhatsappSenderController],
      providers: [
        WhatsappSenderService,
        {
          provide: SenderAlertService,
          useValue: senderAlerts,
        },
        WhatsappConnectionSettingsService,
        { provide: WhatsappConnectionsRepository, useValue: connections },
        { provide: WhatsappConnectService, useValue: connect },
        { provide: ConnectionStatusService, useValue: status },
        { provide: WhatsappDisconnectService, useValue: disconnect },
        {
          provide: ConfigService,
          useValue: new ConfigService({
            ...env,
            [WHATSAPP_OWN_NUMBER_CONFIG]: parsed,
          }),
        },
      ],
    })
      .overrideGuard(DualAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          if (!user) return false;
          context.switchToHttp().getRequest<{ user: unknown }>().user = user;
          return true;
        },
      })
      .compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    return app;
  }

  beforeEach(() => {
    senderAlerts.read.mockReset().mockResolvedValue([]);
    connect.issueTicket.mockReset();
    status.forOrganization.mockReset();
    disconnect.disconnect.mockReset();
    connections.updateThankYouEnabled.mockReset();
    connections.updateThankYouEnabled.mockImplementation(
      (_orgId: string, thankYouEnabled: boolean) =>
        Promise.resolve({ thankYouEnabled }),
    );
    user = {
      userId: 'user-1',
      orgId: ORG,
      role: 'owner',
      source: 'supabase',
    };
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('returns tenant banners to a viewer while connect and email are disabled, without a write', async () => {
    user!.role = 'viewer';
    user!.orgId = OTHER_ORG;
    const banners = [
      {
        kind: 'payment',
        reason: 'payment',
        severity: 'critical',
        action: 'whatsapp_manager',
        templates: [],
      },
    ];
    senderAlerts.read.mockResolvedValue(banners);
    const server = await start({});
    const response = await http(server)
      .get(ROUTE)
      .expect(200)
      .expect('Cache-Control', 'no-store');
    expect(response.body).toMatchObject({ available: false, alerts: banners });
    expect(senderAlerts.read).toHaveBeenCalledWith(OTHER_ORG);
    expect(connections.updateThankYouEnabled).not.toHaveBeenCalled();
    expect(connect.issueTicket).not.toHaveBeenCalled();
  });

  describe('GET connection', () => {
    it('answers the caller organization only, uncached', async () => {
      status.forOrganization.mockResolvedValue(null);
      user = {
        userId: 'user-3',
        orgId: OTHER_ORG,
        role: 'viewer',
        source: 'shopify',
      };
      const server = await start(connectOn);
      const response = await http(server)
        .get(`${ROUTE}/connection`)
        .expect(200)
        .expect('Cache-Control', 'no-store');
      expect(response.body).toEqual({ connection: null });
      expect(status.forOrganization).toHaveBeenCalledWith(OTHER_ORG);
    });

    it('refuses a request the guard does not authenticate', async () => {
      user = null;
      const server = await start(connectOn);
      await http(server).get(`${ROUTE}/connection`).expect(403);
      expect(status.forOrganization).not.toHaveBeenCalled();
    });
  });

  describe('PATCH connection', () => {
    it.each(['owner', 'admin'] as const)(
      'lets %s update either value while switches are off',
      async (role) => {
        user!.role = role;
        const server = await start({});
        for (const thankYouEnabled of [false, true]) {
          const response = await http(server)
            .patch(`${ROUTE}/connection`)
            .send({ thankYouEnabled })
            .expect(200)
            .expect('Cache-Control', 'no-store');
          expect(response.body).toEqual({ thankYouEnabled });
          expect(connections.updateThankYouEnabled).toHaveBeenLastCalledWith(
            ORG,
            thankYouEnabled,
          );
        }
      },
    );

    it('refuses viewers before a write', async () => {
      user!.role = 'viewer';
      const server = await start({});
      const response = await http(server)
        .patch(`${ROUTE}/connection`)
        .send({ thankYouEnabled: false })
        .expect(403);
      expect(response.body).toMatchObject({
        code: 'WHATSAPP_CONNECTION_WRITE_REQUIRED',
      });
      expect(connections.updateThankYouEnabled).not.toHaveBeenCalled();
    });

    it('requires authentication', async () => {
      user = null;
      const server = await start({});
      await http(server)
        .patch(`${ROUTE}/connection`)
        .send({ thankYouEnabled: false })
        .expect(403);
      expect(connections.updateThankYouEnabled).not.toHaveBeenCalled();
    });

    it.each([
      {},
      { thankYouEnabled: 'false' },
      { thankYouEnabled: null },
      { thankYouEnabled: 1 },
      { thankYouEnabled: false, orgId: OTHER_ORG },
    ])(
      'returns a stable validation code for %o without echoing values',
      async (body) => {
        const server = await start({});
        const response = await http(server)
          .patch(`${ROUTE}/connection`)
          .send(body)
          .expect(400);
        expect(response.body).toMatchObject({
          code: 'WHATSAPP_CONNECTION_SETTINGS_INVALID',
        });
        expect(JSON.stringify(response.body)).not.toContain(OTHER_ORG);
        expect(connections.updateThankYouEnabled).not.toHaveBeenCalled();
      },
    );

    it('returns a coded 404 when the caller has no connection', async () => {
      connections.updateThankYouEnabled.mockResolvedValue(null);
      const server = await start({});
      const response = await http(server)
        .patch(`${ROUTE}/connection`)
        .send({ thankYouEnabled: true })
        .expect(404);
      expect(response.body).toMatchObject({
        code: 'WHATSAPP_CONNECTION_NOT_FOUND',
      });
    });
  });

  describe('POST disconnect', () => {
    it('uses the authenticated organization and works with switches off', async () => {
      disconnect.disconnect.mockResolvedValue({
        state: 'disconnected',
        providerCleanup: 'manual_required',
        businessAppSteps: [
          'settings',
          'account',
          'business_platform',
          'disconnect',
        ],
      });
      const server = await start({});
      const response = await http(server)
        .post(`${ROUTE}/disconnect`)
        .send({ orgId: OTHER_ORG })
        .expect(200)
        .expect('Cache-Control', 'no-store');
      expect(disconnect.disconnect).toHaveBeenCalledWith(user);
      expect(response.body).toMatchObject({
        state: 'disconnected',
        providerCleanup: 'manual_required',
      });
    });
    it('requires authentication', async () => {
      user = null;
      const server = await start({});
      await http(server).post(`${ROUTE}/disconnect`).expect(403);
      expect(disconnect.disconnect).not.toHaveBeenCalled();
    });
  });

  it('sits behind the session guard', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, WhatsappSenderController),
    ).toEqual([DualAuthGuard]);
  });

  it('refuses a request the guard does not authenticate', async () => {
    user = null;
    const server = await start(connectOn);
    await http(server).get(ROUTE).expect(403);
  });

  it('answers unavailable, uncached, with the switches off', async () => {
    const server = await start({});
    const response = await http(server)
      .get(ROUTE)
      .expect(200)
      .expect('Cache-Control', 'no-store');
    expect(response.body).toEqual({
      available: false,
      appId: null,
      configId: null,
      canConnect: false,
      alerts: [],
      sendingEnabled: false,
      lastAcceptedSend: null,
      lastAccepted: { confirmation: null, reminder: null },
      permissions: {
        canDisconnect: user!.role === 'owner',
        canUpdateThankYou: user!.role !== 'viewer',
      },
    });
  });

  it('answers the public signup ids, and nothing else, while connect is on', async () => {
    const server = await start(connectOn);
    const response = await http(server)
      .get(ROUTE)
      .expect(200)
      .expect('Cache-Control', 'no-store');
    expect(response.body).toEqual({
      available: true,
      appId: '9876543210',
      configId: '1234567890',
      canConnect: true,
      alerts: [],
      sendingEnabled: false,
      lastAcceptedSend: null,
      lastAccepted: { confirmation: null, reminder: null },
      permissions: {
        canDisconnect: user!.role === 'owner',
        canUpdateThankYou: user!.role !== 'viewer',
      },
    });
    expect(JSON.stringify(response.body)).not.toContain(ENCRYPTION_KEY);
  });

  it.each([
    [ORG, 'supabase'],
    [OTHER_ORG, 'supabase'],
    [ORG, 'shopify'],
    [OTHER_ORG, 'shopify'],
  ] as const)(
    'offers connecting to organization %s through %s despite a retired allowlist',
    async (orgId, source) => {
      user = { userId: 'user-2', orgId, role: 'owner', source };
      const server = await start({
        ...connectOn,
        WHATSAPP_OWN_NUMBER_PILOT_ORG_IDS: 'not-a-uuid',
      });
      const response = await http(server).get(ROUTE).expect(200);
      expect(response.body).toEqual({
        available: true,
        appId: '9876543210',
        configId: '1234567890',
        canConnect: true,
        alerts: [],
        sendingEnabled: false,
        lastAcceptedSend: null,
        lastAccepted: { confirmation: null, reminder: null },
        permissions: {
          canDisconnect: true,
          canUpdateThankYou: true,
        },
      });
    },
  );

  it('answers unavailable with only sending on', async () => {
    const server = await start({
      WHATSAPP_OWN_NUMBER_SENDING_ENABLED: 'true',
      SHOPIFY_TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
    });
    const response = await http(server).get(ROUTE).expect(200);
    expect(response.body).toMatchObject({ available: false });
  });

  it.each(['owner', 'admin', 'viewer'] as const)(
    'answers a %s the same ids, and offers connect to the owner only',
    async (role) => {
      user = { userId: 'user-1', orgId: ORG, role, source: 'shopify' };
      const server = await start(connectOn);
      const response = await http(server).get(ROUTE).expect(200);
      expect(response.body).toEqual({
        available: true,
        appId: '9876543210',
        configId: '1234567890',
        canConnect: role === 'owner',
        alerts: [],
        sendingEnabled: false,
        lastAcceptedSend: null,
        lastAccepted: { confirmation: null, reminder: null },
        permissions: {
          canDisconnect: role === 'owner',
          canUpdateThankYou: role !== 'viewer',
        },
      });
    },
  );

  describe('POST connect-ticket', () => {
    it('hands the body to the service with the caller from the session, uncached', async () => {
      connect.issueTicket.mockResolvedValue({
        connectUrl: 'https://app.example.test/ar/whatsapp/connect?ticket=x',
        expiresAt: '2026-11-02T10:10:00.000Z',
      });
      const server = await start(connectOn);
      await http(server)
        .post(`${ROUTE}/connect-ticket`)
        .send({ locale: 'fr', orgId: OTHER_ORG })
        .expect(201)
        .expect('Cache-Control', 'no-store');
      expect(connect.issueTicket).toHaveBeenCalledWith(user, 'fr');
    });

    it.each([{}, { locale: 'de' }, { locale: ['ar'] }])(
      'answers WHATSAPP_CONNECT_INVALID_REQUEST for %o without echoing it',
      async (body) => {
        const server = await start(connectOn);
        const response = await http(server)
          .post(`${ROUTE}/connect-ticket`)
          .send(body)
          .expect(400);
        expect(response.body).toMatchObject({
          code: 'WHATSAPP_CONNECT_INVALID_REQUEST',
        });
        expect(JSON.stringify(response.body)).not.toContain('locale');
        expect(connect.issueTicket).not.toHaveBeenCalled();
      },
    );

    it('refuses a request the guard does not authenticate', async () => {
      user = null;
      const server = await start(connectOn);
      await http(server)
        .post(`${ROUTE}/connect-ticket`)
        .send({ locale: 'ar' })
        .expect(403);
      expect(connect.issueTicket).not.toHaveBeenCalled();
    });
  });
});
