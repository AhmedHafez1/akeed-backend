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
import type { TemplateSyncRun } from '../../infrastructure/database/repositories/whatsapp-template-sync.repository';
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
import { AdminTemplateInspectionService } from './admin-template-inspection.service';
import { AdminTemplateMetricsService } from './admin-template-metrics.service';
import { AdminTemplateTestSendService } from './admin-template-test-send.service';
import { MessageDispatchResolutionService } from './message-dispatch-resolution.service';
import { AdminTemplatesController } from './admin-templates.controller';
import {
  AdminTemplatesService,
  WHATSAPP_TEMPLATE_SYNC_AUDIT_ACTION,
} from './admin-templates.service';
import { WhatsappTemplateOperatorGuard } from './whatsapp-template-operator.guard';

function run(overrides: Partial<TemplateSyncRun> = {}): TemplateSyncRun {
  return {
    id: randomUUID(),
    trigger: 'manual',
    requestedBy: null,
    status: 'succeeded',
    startedAt: '2026-10-05T10:00:00.000Z',
    finishedAt: '2026-10-05T10:00:02.000Z',
    providerTemplateCount: 9,
    updatedCount: 2,
    unchangedCount: 6,
    missingKeys: [],
    unknownAtProvider: [
      { templateName: 'akeed_marketing_promo', languageCode: 'en_US' },
    ],
    errorCode: null,
    ...overrides,
  };
}

const RANGE = 'from=2026-09-06&to=2026-10-05';
const KEY = 'cod_confirm.ar.standard';

describe('Admin template routes (US-08-04, US-08-05)', () => {
  let app: INestApplication;
  const operatorId = randomUUID();
  const staffId = randomUUID();
  const values: Record<string, unknown> = {};
  const sync = {
    runSync: jest.fn(),
    recentRuns: jest.fn(),
    isEnabled: jest.fn().mockReturnValue(true),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const inspection = { list: jest.fn(), detail: jest.fn() };
  const testSend = { send: jest.fn() };
  const metrics = { getMetrics: jest.fn() };
  const http = () =>
    request(app.getHttpServer() as Parameters<typeof request>[0]);

  function configure(env: Record<string, string>) {
    values.ADMIN_CONTROL_TOWER_ENABLED = 'true';
    values[WHATSAPP_TEMPLATE_CONFIG] = parseWhatsappTemplateConfig({
      WHATSAPP_TEMPLATE_SYNC_ENABLED: 'true',
      WA_BUSINESS_ACCOUNT_ID: '100000000000001',
      WHATSAPP_TEMPLATE_OPERATIONS_ENABLED: 'true',
      WHATSAPP_TEMPLATE_OPERATOR_IDS: operatorId,
      ...env,
    });
  }

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      // The same order as `AdminModule`, which the `metrics` route relies on.
      controllers: [AdminController, AdminTemplatesController],
      providers: [
        AdminAccessGuard,
        WhatsappTemplateOperatorGuard,
        AdminTemplatesService,
        { provide: AdminTemplateInspectionService, useValue: inspection },
        { provide: AdminTemplateTestSendService, useValue: testSend },
        { provide: AdminTemplateMetricsService, useValue: metrics },
        { provide: AdminStoresService, useValue: {} },
        { provide: AdminFunnelService, useValue: {} },
        { provide: MessageDispatchResolutionService, useValue: {} },
        { provide: WhatsappTemplateSyncService, useValue: sync },
        { provide: AdminAccessAuditRepository, useValue: audit },
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
    configure({});
    sync.isEnabled.mockReturnValue(true);
  });

  it.each(['merchant-owner', 'viewer', 'staff-aal1'])(
    'denies %s on every route',
    async (token) => {
      await http()
        .post('/api/admin/templates/sync')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
      await http()
        .get('/api/admin/templates/sync/runs')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
      await http()
        .get(`/api/admin/templates?${RANGE}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
      await http()
        .get(`/api/admin/templates/${KEY}?${RANGE}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
      await http()
        .post(`/api/admin/templates/${KEY}/test-send`)
        .set('Authorization', `Bearer ${token}`)
        .send({ phone: '+201001234567' })
        .expect(403);
      expect(sync.runSync).not.toHaveBeenCalled();
      expect(sync.recentRuns).not.toHaveBeenCalled();
      expect(inspection.list).not.toHaveBeenCalled();
      expect(inspection.detail).not.toHaveBeenCalled();
      expect(testSend.send).not.toHaveBeenCalled();
    },
  );

  it('requires authentication', async () => {
    await http().post('/api/admin/templates/sync').expect(401);
    await http().get(`/api/admin/templates?${RANGE}`).expect(401);
    await http().get(`/api/admin/templates/${KEY}?${RANGE}`).expect(401);
    await http()
      .post(`/api/admin/templates/${KEY}/test-send`)
      .send({ phone: '+201001234567' })
      .expect(401);
    expect(inspection.list).not.toHaveBeenCalled();
    expect(testSend.send).not.toHaveBeenCalled();
  });

  it('is not found while the control tower is off', async () => {
    values.ADMIN_CONTROL_TOWER_ENABLED = 'false';

    await http()
      .post('/api/admin/templates/sync')
      .set('Authorization', 'Bearer operator')
      .expect(404);
    await http()
      .get(`/api/admin/templates?${RANGE}`)
      .set('Authorization', 'Bearer operator')
      .expect(404);
    await http()
      .get(`/api/admin/templates/${KEY}?${RANGE}`)
      .set('Authorization', 'Bearer operator')
      .expect(404);
    await http()
      .post(`/api/admin/templates/${KEY}/test-send`)
      .set('Authorization', 'Bearer operator')
      .send({ phone: '+201001234567' })
      .expect(404);
  });

  it('refuses a sync from staff who are not a named operator', async () => {
    const response = await http()
      .post('/api/admin/templates/sync')
      .set('Authorization', 'Bearer staff')
      .expect(403);

    expect(response.body).toMatchObject({
      code: 'WHATSAPP_TEMPLATE_OPERATOR_REQUIRED',
    });
    expect(sync.runSync).not.toHaveBeenCalled();
  });

  it('refuses every sync while template operations are off', async () => {
    configure({
      WHATSAPP_TEMPLATE_OPERATIONS_ENABLED: 'false',
      WHATSAPP_TEMPLATE_OPERATOR_IDS: operatorId,
    });

    const response = await http()
      .post('/api/admin/templates/sync')
      .set('Authorization', 'Bearer operator')
      .expect(403);

    expect(response.body).toMatchObject({
      code: 'WHATSAPP_TEMPLATE_OPERATIONS_DISABLED',
    });
  });

  it('runs the sync for an operator, audits it with counts only, and returns the result', async () => {
    const finished = run();
    sync.runSync.mockResolvedValue({ outcome: 'succeeded', run: finished });

    const response = await http()
      .post('/api/admin/templates/sync')
      .set('Authorization', 'Bearer operator')
      .set('x-request-id', 'req-1')
      .expect(201);

    expect(sync.runSync).toHaveBeenCalledWith('manual', operatorId);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).toEqual({
      id: finished.id,
      trigger: 'manual',
      status: 'succeeded',
      started_at: finished.startedAt,
      finished_at: finished.finishedAt,
      error_code: null,
      provider_template_count: 9,
      updated_count: 2,
      unchanged_count: 6,
      missing_keys: [],
      unknown_at_provider: [
        { template_name: 'akeed_marketing_promo', language_code: 'en_US' },
      ],
    });
    expect(audit.record).toHaveBeenCalledWith({
      userId: operatorId,
      action: WHATSAPP_TEMPLATE_SYNC_AUDIT_ACTION,
      outcome: 'allowed',
      requestId: 'req-1',
      metadata: {
        runId: finished.id,
        status: 'succeeded',
        errorCode: null,
        updatedCount: 2,
        missingCount: 0,
        unknownAtProviderCount: 1,
      },
    });
  });

  it('shows a failed sync as a failed run with a neutral code', async () => {
    sync.runSync.mockResolvedValue({
      outcome: 'failed',
      run: run({
        status: 'failed',
        errorCode: 'rate_limited',
        updatedCount: null,
      }),
    });

    const response = await http()
      .post('/api/admin/templates/sync')
      .set('Authorization', 'Bearer operator')
      .expect(201);

    expect(response.body).toMatchObject({
      status: 'failed',
      error_code: 'rate_limited',
    });
  });

  it.each([
    [{ outcome: 'disabled' }, 'WHATSAPP_TEMPLATE_SYNC_DISABLED'],
    [{ outcome: 'in_progress' }, 'WHATSAPP_TEMPLATE_SYNC_IN_PROGRESS'],
    [
      { outcome: 'cooldown', retryAfterSeconds: 120, lastRun: run() },
      'WHATSAPP_TEMPLATE_SYNC_COOLDOWN',
    ],
  ])('answers 409 when the sync is refused (%o)', async (result, code) => {
    sync.runSync.mockResolvedValue(result);

    const response = await http()
      .post('/api/admin/templates/sync')
      .set('Authorization', 'Bearer operator')
      .expect(409);

    expect(response.body).toMatchObject({ code });
    expect(audit.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: WHATSAPP_TEMPLATE_SYNC_AUDIT_ACTION }),
    );
  });

  it('lists recent runs to any staff member', async () => {
    sync.recentRuns.mockResolvedValue([
      run({ status: 'failed', errorCode: 'network' }),
    ]);

    const response = await http()
      .get('/api/admin/templates/sync/runs')
      .set('Authorization', 'Bearer staff')
      .expect(200);

    expect(response.body).toMatchObject({
      sync_enabled: true,
      runs: [{ status: 'failed', error_code: 'network' }],
    });
  });

  it('lists templates for any staff member, with the range it was asked for', async () => {
    inspection.list.mockResolvedValue({ templates: [{ key: KEY }] });

    const response = await http()
      .get(`/api/admin/templates?${RANGE}`)
      .set('Authorization', 'Bearer staff')
      .expect(200);

    expect(inspection.list).toHaveBeenCalledWith(staffId, {
      from: '2026-09-06',
      to: '2026-10-05',
    });
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).toEqual({ templates: [{ key: KEY }] });
  });

  it('refuses a list or a detail without a well-formed range', async () => {
    await http()
      .get('/api/admin/templates')
      .set('Authorization', 'Bearer staff')
      .expect(400);
    await http()
      .get(`/api/admin/templates/${KEY}?from=yesterday&to=2026-10-05`)
      .set('Authorization', 'Bearer staff')
      .expect(400);
    expect(inspection.list).not.toHaveBeenCalled();
    expect(inspection.detail).not.toHaveBeenCalled();
  });

  it('shows one template to any staff member', async () => {
    inspection.detail.mockResolvedValue({ template: { key: KEY } });

    const response = await http()
      .get(`/api/admin/templates/${KEY}?${RANGE}`)
      .set('Authorization', 'Bearer staff')
      .expect(200);

    expect(inspection.detail).toHaveBeenCalledWith(staffId, KEY, {
      from: '2026-09-06',
      to: '2026-10-05',
    });
    expect(response.body).toEqual({ template: { key: KEY } });
  });

  it('keeps templates/metrics on the metrics route, not on a template key', async () => {
    metrics.getMetrics.mockResolvedValue({ templates: [] });

    await http()
      .get(`/api/admin/templates/metrics?${RANGE}`)
      .set('Authorization', 'Bearer staff')
      .expect(200);

    expect(metrics.getMetrics).toHaveBeenCalledTimes(1);
    expect(inspection.detail).not.toHaveBeenCalled();
  });

  it('sends a test for an operator', async () => {
    testSend.send.mockResolvedValue({ accepted: true });

    const response = await http()
      .post(`/api/admin/templates/${KEY}/test-send`)
      .set('Authorization', 'Bearer operator')
      .set('x-request-id', 'req-9')
      .send({ phone: ' +201001234567 ', template: 'ignored' })
      .expect(200);

    expect(testSend.send).toHaveBeenCalledWith({
      userId: operatorId,
      key: KEY,
      phone: '+201001234567',
      requestId: 'req-9',
    });
    expect(response.body).toEqual({ accepted: true });
  });

  it('refuses a test send from staff who are not a named operator', async () => {
    const response = await http()
      .post(`/api/admin/templates/${KEY}/test-send`)
      .set('Authorization', 'Bearer staff')
      .send({ phone: '+201001234567' })
      .expect(403);

    expect(response.body).toMatchObject({
      code: 'WHATSAPP_TEMPLATE_OPERATOR_REQUIRED',
    });
    expect(testSend.send).not.toHaveBeenCalled();
  });

  it('refuses every test send while template operations are off', async () => {
    configure({
      WHATSAPP_TEMPLATE_OPERATIONS_ENABLED: 'false',
      WHATSAPP_TEMPLATE_OPERATOR_IDS: operatorId,
    });

    const response = await http()
      .post(`/api/admin/templates/${KEY}/test-send`)
      .set('Authorization', 'Bearer operator')
      .send({ phone: '+201001234567' })
      .expect(403);

    expect(response.body).toMatchObject({
      code: 'WHATSAPP_TEMPLATE_OPERATIONS_DISABLED',
    });
    expect(testSend.send).not.toHaveBeenCalled();
  });

  it.each([{}, { phone: 20100 }, { phone: '123' }])(
    'refuses a test send without a usable phone (%o)',
    async (body) => {
      await http()
        .post(`/api/admin/templates/${KEY}/test-send`)
        .set('Authorization', 'Bearer operator')
        .send(body)
        .expect(400);
      expect(testSend.send).not.toHaveBeenCalled();
    },
  );

  it('serves exactly these routes', () => {
    const prototype = AdminTemplatesController.prototype as unknown as Record<
      string,
      unknown
    >;
    const routes = Object.getOwnPropertyNames(prototype)
      .filter((name) => name !== 'constructor')
      .map((name) => {
        const handler = prototype[name] as object;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as number;
        return `${RequestMethod[method]} ${String(Reflect.getMetadata(PATH_METADATA, handler))}`;
      });

    expect(routes.sort()).toEqual([
      'GET /',
      'GET :key',
      'GET sync/runs',
      'POST :key/test-send',
      'POST sync',
    ]);
  });
});
