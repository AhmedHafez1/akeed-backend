import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import type { Server } from 'node:http';
import { join, relative, resolve } from 'node:path';
import {
  Logger,
  RequestMethod,
  ValidationPipe,
  type INestApplication,
  type Type,
} from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AdminAccessAuditRepository } from '../../src/infrastructure/database/repositories/admin-access-audit.repository';
import { AdminAccessGuard } from '../../src/modules/admin/admin-access.guard';
import { AdminController } from '../../src/modules/admin/admin.controller';
import { AdminFunnelService } from '../../src/modules/admin/admin-funnel.service';
import { AdminMessageTextsController } from '../../src/modules/admin/admin-message-texts.controller';
import { AdminMessageTextsService } from '../../src/modules/admin/admin-message-texts.service';
import { AdminStoresService } from '../../src/modules/admin/admin-stores.service';
import { AdminTemplateAuthoringController } from '../../src/modules/admin/admin-template-authoring.controller';
import { AdminTemplateDraftService } from '../../src/modules/admin/admin-template-draft.service';
import { AdminTemplateInspectionService } from '../../src/modules/admin/admin-template-inspection.service';
import { AdminTemplateLifecycleService } from '../../src/modules/admin/admin-template-lifecycle.service';
import { AdminTemplateMetricsService } from '../../src/modules/admin/admin-template-metrics.service';
import { AdminTemplateTestSendService } from '../../src/modules/admin/admin-template-test-send.service';
import { AdminTemplatesController } from '../../src/modules/admin/admin-templates.controller';
import { AdminTemplatesService } from '../../src/modules/admin/admin-templates.service';
import { MessageDispatchResolutionService } from '../../src/modules/admin/message-dispatch-resolution.service';
import { WhatsappTemplateOperatorGuard } from '../../src/modules/admin/whatsapp-template-operator.guard';
import { TokenValidatorService } from '../../src/modules/auth/services/token-validator.service';
import {
  WHATSAPP_TEMPLATE_CONFIG,
  parseWhatsappTemplateConfig,
} from '../../src/shared/config/whatsapp-template.config';
import { FAKE_MESSAGES_TOKEN } from '../contracts/meta-messages-fake';
import { FAKE_TOKEN } from '../contracts/meta-template-api-fake';

/**
 * US-08-08 criterion 6: who can reach the template routes.
 *
 * The routes are read from the controllers by reflection, so a route added
 * later is in the matrix without anyone listing it. The guards and the staff
 * token check are the real ones; only Supabase's answer to "whose token is
 * this" and the services behind the routes are stand-ins.
 */
const KEY = 'cod_confirm.en.warm_v1';
const DRAFT_ID = '3f1b6c1e-2d4a-4c3b-9a8e-1f2e3d4c5b6a';
const RANGE = 'from=2026-09-06&to=2026-10-05';
const OPERATOR_ID = randomUUID();
const STAFF_ID = randomUUID();
const SECRETS = {
  META_APP_SECRET: 'gate-app-secret-never-real',
  WA_ACCESS_TOKEN: 'EAAG-gate-access-token-never-real',
  SUPABASE_SERVICE_ROLE_KEY: 'gate-service-role-key-never-real',
};

const TEXT = {
  body: 'Hello {{customer}}, your order is ready to confirm today.',
  confirm_label: 'Confirm order',
  cancel_label: 'Cancel order',
  samples: { customer: 'Ahmed' },
};
const DRAFT = {
  ...TEXT,
  purpose: 'cod_confirmation',
  language: 'en',
  style: 'warm',
  language_code: 'en',
  parameter_format: 'named',
};
/** A body each write accepts, by `METHOD path` as the controller declares it. */
const BODIES: Record<string, object> = {
  'POST drafts/validate': DRAFT,
  'POST drafts': DRAFT,
  'PATCH drafts/:id': {
    ...TEXT,
    language_code: 'en',
    parameter_format: 'named',
  },
  'POST :key/edit': TEXT,
  'POST :key/deactivate': {},
  'POST :key/retire': {},
  'POST :key/test-send': { phone: '+201001234567' },
  'PUT /': {
    purpose: 'ack_confirmed',
    language: 'en',
    style: 'default',
    body: 'Your order #{{order}} from {{store}} is confirmed.',
    is_active: true,
  },
};

interface Route {
  name: string;
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  url: string;
  body?: object;
  write: boolean;
  guards: unknown[];
}

function routesOf(controller: Type<unknown>, only?: RegExp): Route[] {
  const base = String(Reflect.getMetadata(PATH_METADATA, controller));
  const prototype = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(prototype)
    .filter(
      (name) =>
        name !== 'constructor' &&
        Reflect.hasMetadata(PATH_METADATA, prototype[name] as object),
    )
    .map((name) => {
      const handler = prototype[name] as object;
      const verb =
        RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number];
      const path = String(Reflect.getMetadata(PATH_METADATA, handler));
      const declared = `${verb} ${path}`;
      const suffix = path === '/' ? '' : `/${path}`;
      const url = `/${base}${suffix}`
        .replace(':key', KEY)
        .replace(':id', DRAFT_ID);
      return {
        name: `${verb} /${base}${suffix}`,
        method: verb.toLowerCase() as Route['method'],
        url: verb === 'GET' ? `${url}?${RANGE}` : url,
        body: BODIES[declared],
        write: verb !== 'GET',
        guards: [
          ...((Reflect.getMetadata(GUARDS_METADATA, controller) ??
            []) as unknown[]),
          ...((Reflect.getMetadata(GUARDS_METADATA, handler) ??
            []) as unknown[]),
        ],
      };
    })
    .filter((route) => !only || only.test(route.name));
}

const ROUTES: Route[] = [
  ...routesOf(AdminTemplatesController),
  ...routesOf(AdminTemplateAuthoringController),
  ...routesOf(AdminMessageTextsController),
  ...routesOf(AdminController, /\/api\/admin\/templates\//),
];
const WRITES = ROUTES.filter((route) => route.write);
const READS = ROUTES.filter((route) => !route.write);

function jwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.');
}

/** Whose token it is, as Supabase would answer. */
const SUPABASE_USERS = new Map<string, Record<string, unknown>>();
function supabaseToken(
  label: string,
  user: { id: string; akeedRole?: string },
  aal: 'aal1' | 'aal2',
): string {
  const token = jwt({ aud: 'authenticated', aal, sub: user.id, label });
  SUPABASE_USERS.set(token, {
    id: user.id,
    app_metadata: user.akeedRole ? { akeed_role: user.akeedRole } : {},
  });
  return token;
}

const TOKENS = {
  operator: supabaseToken(
    'operator',
    { id: OPERATOR_ID, akeedRole: 'admin' },
    'aal2',
  ),
  staff: supabaseToken('staff', { id: STAFF_ID, akeedRole: 'admin' }, 'aal2'),
  staffWithoutMfa: supabaseToken(
    'staff-aal1',
    { id: randomUUID(), akeedRole: 'admin' },
    'aal1',
  ),
  merchantOwner: supabaseToken('owner', { id: randomUUID() }, 'aal2'),
  merchantViewer: supabaseToken(
    'viewer',
    { id: randomUUID(), akeedRole: 'viewer' },
    'aal2',
  ),
  shopifyMerchant: jwt({
    dest: 'https://akeed-gate.myshopify.com',
    aud: 'shopify-key',
    sub: '1',
  }),
  unknownToSupabase: jwt({ aud: 'authenticated', aal: 'aal2', sub: 'nobody' }),
};
const NON_STAFF = [
  'merchantOwner',
  'merchantViewer',
  'shopifyMerchant',
  'staffWithoutMfa',
  'unknownToSupabase',
] as const;

describe('US-08-08 role and operator controls', () => {
  let app: INestApplication;
  let lines: string[];
  let responses: string[];
  let serviceCalls = 0;
  const values: Record<string, unknown> = {};
  const audit = { record: jest.fn().mockResolvedValue(undefined) };

  /** A service whose every method counts the call and answers `{}`. */
  const countingService = () =>
    new Proxy(
      {},
      {
        get: (_target, property) =>
          property === 'then'
            ? undefined
            : () => {
                serviceCalls += 1;
                return Promise.resolve({});
              },
      },
    );

  function configure(env: Record<string, string> = {}) {
    values.ADMIN_CONTROL_TOWER_ENABLED = 'true';
    values.ADMIN_REQUIRE_AAL2 = 'true';
    Object.assign(values, SECRETS);
    values[WHATSAPP_TEMPLATE_CONFIG] = parseWhatsappTemplateConfig({
      WHATSAPP_TEMPLATE_OPERATIONS_ENABLED: 'true',
      WHATSAPP_TEMPLATE_OPERATOR_IDS: OPERATOR_ID,
      ...env,
    });
  }

  async function send(route: Route, token?: string) {
    let call = request(app.getHttpServer() as Server)
      [route.method](route.url)
      .set('x-request-id', 'gate-request');
    if (token) call = call.set('Authorization', `Bearer ${token}`);
    const response = await (route.body ? call.send(route.body) : call);
    responses.push(`${JSON.stringify(response.headers)}\n${response.text}`);
    return response;
  }

  beforeAll(async () => {
    configure();
    const config = {
      get: (key: string) => values[key],
      getOrThrow: (key: string) =>
        key === 'SUPABASE_URL' ? 'https://example.supabase.co' : values[key],
    };
    const tokenValidator = new TokenValidatorService(
      config as never,
      {} as never,
      {} as never,
    );
    Object.defineProperty(tokenValidator, 'supabase', {
      value: {
        auth: {
          getUser: (token: string) => {
            const user = SUPABASE_USERS.get(token);
            return Promise.resolve(
              user
                ? { data: { user }, error: null }
                : { data: { user: null }, error: new Error('invalid') },
            );
          },
        },
      },
    });
    const services = [
      AdminTemplatesService,
      AdminTemplateInspectionService,
      AdminTemplateTestSendService,
      AdminTemplateMetricsService,
      AdminTemplateDraftService,
      AdminTemplateLifecycleService,
      AdminMessageTextsService,
      AdminStoresService,
      AdminFunnelService,
      MessageDispatchResolutionService,
    ];
    const module = await Test.createTestingModule({
      // The same controllers, in the same order, as `AdminModule`.
      controllers: [
        AdminController,
        AdminTemplateAuthoringController,
        AdminTemplatesController,
        AdminMessageTextsController,
      ],
      providers: [
        AdminAccessGuard,
        WhatsappTemplateOperatorGuard,
        ...services.map((provide) => ({
          provide,
          useValue: countingService(),
        })),
        { provide: AdminAccessAuditRepository, useValue: audit },
        { provide: ConfigService, useValue: config },
        { provide: TokenValidatorService, useValue: tokenValidator },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    jest.clearAllMocks();
    configure();
    serviceCalls = 0;
    responses = [];
    lines = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => {
          lines.push(String(args[0]));
        });
    }
  });

  afterEach(() => {
    const seen = [...lines, ...responses].join('\n');
    jest.restoreAllMocks();
    // No session token and no configured secret in a log line or a response.
    for (const secret of [
      ...Object.values(TOKENS),
      ...Object.values(SECRETS),
    ]) {
      expect(seen).not.toContain(secret);
    }
  });

  it('covers the routes the story lists, and none that deletes a template at Meta', () => {
    expect(ROUTES.map((route) => route.name).sort()).toEqual([
      'DELETE /api/admin/templates/drafts/:id',
      'GET /api/admin/message-texts',
      'GET /api/admin/templates',
      'GET /api/admin/templates/:key',
      'GET /api/admin/templates/:key/impact',
      'GET /api/admin/templates/drafts',
      'GET /api/admin/templates/drafts/:id',
      'GET /api/admin/templates/metrics',
      'GET /api/admin/templates/sync/runs',
      'PATCH /api/admin/templates/drafts/:id',
      'POST /api/admin/templates/:key/activate',
      'POST /api/admin/templates/:key/deactivate',
      'POST /api/admin/templates/:key/edit',
      'POST /api/admin/templates/:key/retire',
      'POST /api/admin/templates/:key/set-default',
      'POST /api/admin/templates/:key/test-send',
      'POST /api/admin/templates/drafts',
      'POST /api/admin/templates/drafts/:id/reconcile',
      'POST /api/admin/templates/drafts/:id/submit',
      'POST /api/admin/templates/drafts/validate',
      'POST /api/admin/templates/sync',
      'PUT /api/admin/message-texts',
    ]);
  });

  it('puts the staff guard on every route and the operator guard on every route that is not a GET', () => {
    for (const route of ROUTES) {
      expect([route.name, route.guards.includes(AdminAccessGuard)]).toEqual([
        route.name,
        true,
      ]);
      expect([
        route.name,
        route.guards.includes(WhatsappTemplateOperatorGuard),
      ]).toEqual([route.name, route.write]);
      // The staff guard runs first: it is what sets `request.admin`.
      expect(route.guards[0]).toBe(AdminAccessGuard);
    }
  });

  describe.each(ROUTES)('$name', (route) => {
    it.each(NON_STAFF)(
      'answers 403 to %s and reaches no service',
      async (who) => {
        const response = await send(route, TOKENS[who]);

        expect([401, 403]).toContain(response.status);
        expect(response.status).toBe(who === 'unknownToSupabase' ? 401 : 403);
        expect(serviceCalls).toBe(0);
        expect(audit.record).toHaveBeenCalledTimes(1);
        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: 'denied' }),
        );
      },
    );

    it('answers 401 without a token', async () => {
      await expect(send(route)).resolves.toMatchObject({ status: 401 });
      expect(serviceCalls).toBe(0);
    });

    it('is not found for anyone, staff and operators included, while the control tower is off', async () => {
      values.ADMIN_CONTROL_TOWER_ENABLED = 'false';

      for (const token of [undefined, ...Object.values(TOKENS)]) {
        await expect(send(route, token)).resolves.toMatchObject({
          status: 404,
        });
      }
      expect(serviceCalls).toBe(0);
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('is served to a named operator', async () => {
      const response = await send(route, TOKENS.operator);

      expect(response.status).toBeLessThan(300);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(serviceCalls).toBe(1);
    });
  });

  describe.each(READS)('$name', (route) => {
    it('is served to staff who are not operators, with operations on or off', async () => {
      await expect(send(route, TOKENS.staff)).resolves.toMatchObject({
        status: 200,
      });
      configure({ WHATSAPP_TEMPLATE_OPERATIONS_ENABLED: 'false' });
      await expect(send(route, TOKENS.staff)).resolves.toMatchObject({
        status: 200,
      });
      expect(serviceCalls).toBe(2);
    });
  });

  describe.each(WRITES)('$name', (route) => {
    it('answers 403 with a stable code to staff who are not a named operator', async () => {
      const response = await send(route, TOKENS.staff);

      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({
        code: 'WHATSAPP_TEMPLATE_OPERATOR_REQUIRED',
      });
      expect(serviceCalls).toBe(0);
    });

    it('answers 403 to everyone, a named operator included, while WHATSAPP_TEMPLATE_OPERATIONS_ENABLED is false', async () => {
      configure({
        WHATSAPP_TEMPLATE_OPERATIONS_ENABLED: 'false',
        WHATSAPP_TEMPLATE_OPERATOR_IDS: OPERATOR_ID,
      });

      for (const token of [TOKENS.operator, TOKENS.staff]) {
        const response = await send(route, token);
        expect(response.status).toBe(403);
        expect(response.body).toMatchObject({
          code: 'WHATSAPP_TEMPLATE_OPERATIONS_DISABLED',
        });
      }
      expect(serviceCalls).toBe(0);
    });

    it('answers 403 to an operator of another environment, whose ID is not on this list', async () => {
      configure({ WHATSAPP_TEMPLATE_OPERATOR_IDS: randomUUID() });

      await expect(send(route, TOKENS.operator)).resolves.toMatchObject({
        status: 403,
      });
      expect(serviceCalls).toBe(0);
    });
  });
});

/**
 * US-08-08 criterion 6, last point: no fixture carries a token or an app
 * secret. The fakes' own tokens are synthetic and live in `test/contracts`,
 * not in a fixture; they must not have leaked into one either.
 */
describe('US-08-08 fixture secret scan', () => {
  const ROOT = resolve(__dirname, '../fixtures/whatsapp-templates');
  const PATTERNS: [string, RegExp][] = [
    ['a Meta access token', /EAA[A-Za-z0-9]{20,}/],
    ['an access_token parameter', /access_token\s*["'=:]/i],
    ['a bearer value', /Bearer\s+[A-Za-z0-9._-]{8,}/],
    ['an app secret', /app[_-]?secret["'\s]*[:=]/i],
    ['a signature header value', /sha256=[a-f0-9]{64}/i],
    ['a JSON web token', /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./],
  ];

  function files(directory: string): string[] {
    return readdirSync(directory).flatMap((name) => {
      const path = join(directory, name);
      return statSync(path).isDirectory() ? files(path) : [path];
    });
  }

  const all = files(ROOT);

  it('reads every committed E08 fixture', () => {
    expect(all.length).toBeGreaterThanOrEqual(25);
  });

  it.each(
    all.map((path) => [relative(ROOT, path).replaceAll('\\', '/'), path]),
  )('%s holds no token, secret or signature', (_name, path) => {
    const text = readFileSync(path, 'utf8');

    for (const [what, pattern] of PATTERNS) {
      expect([what, pattern.test(text)]).toEqual([what, false]);
    }
    expect(text).not.toContain(FAKE_TOKEN);
    expect(text).not.toContain(FAKE_MESSAGES_TOKEN);
  });

  it('keeps real account identifiers out: every account ID in a fixture is the synthetic one or a placeholder', () => {
    for (const path of all) {
      const text = readFileSync(path, 'utf8');
      const accountIds = [
        ...text.matchAll(/"id":\s*"(\d{12,})"\s*,\s*"time"/g),
      ].map((match) => match[1]);
      expect([
        path,
        accountIds.every((id) => id === '100000000000001'),
      ]).toEqual([path, true]);
    }
  });
});
