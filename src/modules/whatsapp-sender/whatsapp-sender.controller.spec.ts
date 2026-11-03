import { type ExecutionContext, type INestApplication } from '@nestjs/common';
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

  async function start(env: Record<string, string>) {
    const parsed = parseWhatsappOwnNumberConfig(env);
    const module = await Test.createTestingModule({
      controllers: [WhatsappSenderController],
      providers: [
        WhatsappSenderService,
        { provide: WhatsappConnectService, useValue: connect },
        { provide: ConnectionStatusService, useValue: status },
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
    await app.init();
    return app;
  }

  beforeEach(() => {
    connect.issueTicket.mockReset();
    status.forOrganization.mockReset();
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
