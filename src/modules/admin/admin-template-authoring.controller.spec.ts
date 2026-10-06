import { randomUUID } from 'node:crypto';
import {
  ForbiddenException,
  RequestMethod,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AdminAccessAuditRepository } from '../../infrastructure/database/repositories/admin-access-audit.repository';
import {
  WHATSAPP_TEMPLATE_CONFIG,
  parseWhatsappTemplateConfig,
} from '../../shared/config/whatsapp-template.config';
import { TokenValidatorService } from '../auth/services/token-validator.service';
import { WhatsappTemplateSyncService } from '../template-registry/whatsapp-template-sync.service';
import { AdminAccessGuard } from './admin-access.guard';
import { AdminController } from './admin.controller';
import { AdminFunnelService } from './admin-funnel.service';
import { AdminStoresService } from './admin-stores.service';
import { AdminTemplateAuthoringController } from './admin-template-authoring.controller';
import { AdminTemplateDraftService } from './admin-template-draft.service';
import { AdminTemplateInspectionService } from './admin-template-inspection.service';
import { AdminTemplateLifecycleService } from './admin-template-lifecycle.service';
import { AdminTemplateMetricsService } from './admin-template-metrics.service';
import { AdminTemplateTestSendService } from './admin-template-test-send.service';
import { AdminTemplatesController } from './admin-templates.controller';
import { AdminTemplatesService } from './admin-templates.service';
import { MessageDispatchResolutionService } from './message-dispatch-resolution.service';
import { WhatsappTemplateOperatorGuard } from './whatsapp-template-operator.guard';

const KEY = 'cod_confirm.en.warm_v1';
const DRAFT_ID = '3f1b6c1e-2d4a-4c3b-9a8e-1f2e3d4c5b6a';

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

/** Every write route, with a body it accepts. */
const WRITES: [string, 'post' | 'patch' | 'delete', string, object?][] = [
  ['validate a draft', 'post', '/drafts/validate', DRAFT],
  ['create a draft', 'post', '/drafts', DRAFT],
  [
    'update a draft',
    'patch',
    `/drafts/${DRAFT_ID}`,
    { ...TEXT, language_code: 'en', parameter_format: 'named' },
  ],
  ['discard a draft', 'delete', `/drafts/${DRAFT_ID}`],
  ['submit a draft', 'post', `/drafts/${DRAFT_ID}/submit`],
  ['check the provider', 'post', `/drafts/${DRAFT_ID}/reconcile`],
  ['edit a template', 'post', `/${KEY}/edit`, TEXT],
  ['activate', 'post', `/${KEY}/activate`],
  ['deactivate', 'post', `/${KEY}/deactivate`, {}],
  ['set the default', 'post', `/${KEY}/set-default`],
  ['retire', 'post', `/${KEY}/retire`, {}],
];

describe('Admin template write routes (US-08-06)', () => {
  let app: INestApplication;
  const operatorId = randomUUID();
  const staffId = randomUUID();
  const values: Record<string, unknown> = {};
  const drafts = {
    list: jest.fn().mockResolvedValue({ drafts: [] }),
    get: jest.fn().mockResolvedValue({ draft: {} }),
    check: jest.fn().mockResolvedValue({ validation: { valid: true } }),
    create: jest.fn().mockResolvedValue({ draft: {} }),
    update: jest.fn().mockResolvedValue({ draft: {} }),
    discard: jest.fn().mockResolvedValue({ discarded: true }),
    submit: jest.fn().mockResolvedValue({ outcome: 'created' }),
    reconcile: jest.fn().mockResolvedValue({ outcome: 'adopted' }),
  };
  const lifecycle = {
    impact: jest.fn().mockResolvedValue({ key: KEY }),
    act: jest.fn().mockResolvedValue({ key: KEY }),
    edit: jest.fn().mockResolvedValue({ key: KEY, review_status: 'pending' }),
  };
  const inspection = { list: jest.fn(), detail: jest.fn() };
  const calls = () =>
    [...Object.values(drafts), ...Object.values(lifecycle)].reduce(
      (total, mock) => total + mock.mock.calls.length,
      0,
    );
  const http = () =>
    request(app.getHttpServer() as Parameters<typeof request>[0]);
  const send = (
    token: string,
    method: 'post' | 'patch' | 'delete' | 'get',
    path: string,
    body?: object,
  ) => {
    const call = http()
      [method](`/api/admin/templates${path}`)
      .set('Authorization', `Bearer ${token}`)
      .set('x-request-id', 'req-9');
    return body ? call.send(body) : call;
  };

  function configure(env: Record<string, string> = {}) {
    values.ADMIN_CONTROL_TOWER_ENABLED = 'true';
    values[WHATSAPP_TEMPLATE_CONFIG] = parseWhatsappTemplateConfig({
      WHATSAPP_TEMPLATE_OPERATIONS_ENABLED: 'true',
      WHATSAPP_TEMPLATE_OPERATOR_IDS: operatorId,
      ...env,
    });
  }

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      // The same order as `AdminModule`: the literal `drafts` routes must be
      // matched before `AdminTemplatesController`'s `:key` routes.
      controllers: [
        AdminController,
        AdminTemplateAuthoringController,
        AdminTemplatesController,
      ],
      providers: [
        AdminAccessGuard,
        WhatsappTemplateOperatorGuard,
        { provide: AdminTemplateDraftService, useValue: drafts },
        { provide: AdminTemplateLifecycleService, useValue: lifecycle },
        { provide: AdminTemplatesService, useValue: {} },
        { provide: AdminTemplateInspectionService, useValue: inspection },
        { provide: AdminTemplateTestSendService, useValue: {} },
        { provide: AdminTemplateMetricsService, useValue: {} },
        { provide: AdminStoresService, useValue: {} },
        { provide: AdminFunnelService, useValue: {} },
        { provide: MessageDispatchResolutionService, useValue: {} },
        { provide: WhatsappTemplateSyncService, useValue: {} },
        {
          provide: AdminAccessAuditRepository,
          useValue: { record: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: ConfigService,
          useValue: { get: (key: string) => values[key] },
        },
        {
          provide: TokenValidatorService,
          useValue: {
            validateAdminToken: jest.fn((token: string) => {
              if (token !== 'operator' && token !== 'staff')
                throw new ForbiddenException('Staff MFA required');
              return {
                userId: token === 'operator' ? operatorId : staffId,
                role: 'admin',
                aal: 'aal2',
                source: 'supabase',
              };
            }),
          },
        },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => app.close());

  beforeEach(() => {
    jest.clearAllMocks();
    configure();
  });

  describe.each(WRITES)('%s', (_name, method, path, body) => {
    it('is allowed for a named operator', async () => {
      const response = await send('operator', method, path, body);

      expect(response.status).toBeLessThan(300);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(calls()).toBe(1);
    });

    it('answers 403 with a stable code for staff who are not operators', async () => {
      const response = await send('staff', method, path, body).expect(403);

      expect(response.body).toMatchObject({
        code: 'WHATSAPP_TEMPLATE_OPERATOR_REQUIRED',
      });
      expect(calls()).toBe(0);
    });

    it('answers 403 for everyone while the switch is off', async () => {
      configure({ WHATSAPP_TEMPLATE_OPERATIONS_ENABLED: 'false' });

      const response = await send('operator', method, path, body).expect(403);

      expect(response.body).toMatchObject({
        code: 'WHATSAPP_TEMPLATE_OPERATIONS_DISABLED',
      });
      expect(calls()).toBe(0);
    });

    it('answers 403 to anyone who is not staff', async () => {
      await send('merchant', method, path, body).expect(403);
      expect(calls()).toBe(0);
    });
  });

  it('lets any staff member read drafts and an action impact', async () => {
    await send('staff', 'get', '/drafts').expect(200);
    await send('staff', 'get', `/drafts/${DRAFT_ID}`).expect(200);
    await send('staff', 'get', `/${KEY}/impact`).expect(200);

    expect(drafts.list).toHaveBeenCalledWith(staffId);
    expect(drafts.get).toHaveBeenCalledWith(staffId, DRAFT_ID);
    expect(lifecycle.impact).toHaveBeenCalledWith(KEY);
    // `drafts` never reaches the `:key` route of the read controller.
    expect(inspection.detail).not.toHaveBeenCalled();
  });

  it('passes the actor, the request ID and the replacement to each action', async () => {
    await send('operator', 'post', `/${KEY}/retire`, {
      replacement_key: 'cod_confirm.en.friendly',
    }).expect(200);
    await send('operator', 'post', `/${KEY}/set-default`).expect(200);
    await send('operator', 'post', `/drafts/${DRAFT_ID}/submit`).expect(200);

    expect(lifecycle.act).toHaveBeenNthCalledWith(1, {
      userId: operatorId,
      key: KEY,
      action: 'retire',
      replacementKey: 'cod_confirm.en.friendly',
      requestId: 'req-9',
    });
    expect(lifecycle.act).toHaveBeenNthCalledWith(2, {
      userId: operatorId,
      key: KEY,
      action: 'set_default',
      replacementKey: undefined,
      requestId: 'req-9',
    });
    expect(drafts.submit).toHaveBeenCalledWith(operatorId, DRAFT_ID, 'req-9');
  });

  it.each([
    ['a body that is not text', { ...DRAFT, body: 7 }],
    ['an unknown purpose', { ...DRAFT, purpose: 'marketing_promo' }],
    ['an unknown language', { ...DRAFT, language: 'fr' }],
    ['an unknown parameter format', { ...DRAFT, parameter_format: 'mixed' }],
    ['a body past the storage bound', { ...DRAFT, body: 'a'.repeat(4097) }],
  ])('answers 400 to a draft with %s', async (_case, body) => {
    await send('operator', 'post', '/drafts', body).expect(400);
    expect(drafts.create).not.toHaveBeenCalled();
  });

  it('answers 400 to a draft ID that is not a UUID and to a malformed replacement', async () => {
    await send('operator', 'post', '/drafts/not-a-uuid/submit').expect(400);
    await send('operator', 'post', `/${KEY}/retire`, {
      replacement_key: 'DROP TABLE',
    }).expect(400);
    expect(calls()).toBe(0);
  });

  it('tells the session whether the user is a template operator', async () => {
    const session = (token: string) =>
      http().get('/api/admin/session').set('Authorization', `Bearer ${token}`);

    expect((await session('operator').expect(200)).body).toMatchObject({
      template_operations: { enabled: true, operator: true },
    });
    expect((await session('staff').expect(200)).body).toMatchObject({
      template_operations: { enabled: true, operator: false },
    });
    configure({ WHATSAPP_TEMPLATE_OPERATIONS_ENABLED: 'false' });
    expect((await session('operator').expect(200)).body).toMatchObject({
      template_operations: { enabled: false, operator: false },
    });
  });

  it('serves exactly these routes, and none that deletes a template', () => {
    const prototype =
      AdminTemplateAuthoringController.prototype as unknown as Record<
        string,
        unknown
      >;
    const routes = Object.getOwnPropertyNames(prototype)
      .filter(
        (name) =>
          name !== 'constructor' &&
          Reflect.hasMetadata(PATH_METADATA, prototype[name] as object),
      )
      .map((name) => {
        const handler = prototype[name] as object;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as number;
        return `${RequestMethod[method]} ${String(Reflect.getMetadata(PATH_METADATA, handler))}`;
      });

    expect(routes.sort()).toEqual([
      'DELETE drafts/:id',
      'GET :key/impact',
      'GET drafts',
      'GET drafts/:id',
      'PATCH drafts/:id',
      'POST :key/activate',
      'POST :key/deactivate',
      'POST :key/edit',
      'POST :key/retire',
      'POST :key/set-default',
      'POST drafts',
      'POST drafts/:id/reconcile',
      'POST drafts/:id/submit',
      'POST drafts/validate',
    ]);
  });
});
