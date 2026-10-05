import { randomUUID } from 'node:crypto';
import {
  ForbiddenException,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AdminAccessAuditRepository } from '../../infrastructure/database/repositories/admin-access-audit.repository';
import { TokenValidatorService } from '../auth/services/token-validator.service';
import { AdminAccessGuard } from './admin-access.guard';
import { AdminController } from './admin.controller';
import { AdminFunnelService } from './admin-funnel.service';
import { AdminQueryRepository } from './admin-query.repository';
import { AdminStoresService } from './admin-stores.service';
import { AdminTemplateMetricsService } from './admin-template-metrics.service';
import { MessageDispatchResolutionService } from './message-dispatch-resolution.service';

const ROUTE = '/api/admin/templates/metrics';

describe('Template metrics staff HTTP boundary', () => {
  const staffId = randomUUID();
  const repository = {
    findTemplateMetrics: jest.fn().mockResolvedValue([]),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };

  async function createApp(environment: Record<string, string>) {
    const module = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [
        AdminAccessGuard,
        // The real service, so the range rules are exercised over HTTP.
        AdminTemplateMetricsService,
        { provide: AdminQueryRepository, useValue: repository },
        { provide: AdminStoresService, useValue: {} },
        { provide: AdminFunnelService, useValue: {} },
        { provide: MessageDispatchResolutionService, useValue: {} },
        { provide: ConfigService, useValue: new ConfigService(environment) },
        { provide: AdminAccessAuditRepository, useValue: audit },
        {
          provide: TokenValidatorService,
          useValue: {
            validateAdminToken: jest.fn((token: string) => {
              if (token !== 'staff-aal2')
                throw new ForbiddenException('Staff access required');
              return {
                userId: staffId,
                role: 'admin',
                aal: 'aal2',
                source: 'supabase',
              };
            }),
          },
        },
      ],
    }).compile();
    const app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    return app;
  }

  const http = (app: INestApplication) =>
    request(app.getHttpServer() as Parameters<typeof request>[0]);

  describe('with the control tower enabled', () => {
    let app: INestApplication;
    beforeAll(async () => {
      app = await createApp({ ADMIN_CONTROL_TOWER_ENABLED: 'true' });
    });
    afterAll(async () => app.close());
    beforeEach(() => jest.clearAllMocks());

    it('requires a token', async () => {
      await http(app).get(`${ROUTE}?from=2026-09-01&to=2026-09-30`).expect(401);
      expect(repository.findTemplateMetrics).not.toHaveBeenCalled();
    });

    it.each(['merchant-owner', 'organization-admin', 'viewer', 'staff-aal1'])(
      'denies %s',
      async (token) => {
        await http(app)
          .get(`${ROUTE}?from=2026-09-01&to=2026-09-30`)
          .set('Authorization', `Bearer ${token}`)
          .expect(403);
        expect(repository.findTemplateMetrics).not.toHaveBeenCalled();
      },
    );

    it('answers staff, uncached, and audits the read', async () => {
      const response = await http(app)
        .get(`${ROUTE}?from=2026-09-01&to=2026-09-30&include_test=true`)
        .set('Authorization', 'Bearer staff-aal2')
        .expect('Cache-Control', 'private, no-store')
        .expect(200);

      expect(repository.findTemplateMetrics).toHaveBeenCalledWith({
        from: '2026-09-01T00:00:00.000Z',
        toExclusive: '2026-10-01T00:00:00.000Z',
        includeTest: true,
      });
      expect(response.body).toMatchObject({
        range: { from: '2026-09-01', to: '2026-09-30', timezone: 'UTC' },
        include_test: true,
        templates: [],
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: staffId,
          action: `GET ${ROUTE}`,
          outcome: 'allowed',
        }),
      );
    });

    it.each([
      ['no range', ''],
      ['a missing end', '?from=2026-09-01'],
      ['a missing start', '?to=2026-09-30'],
      ['a date with a time', '?from=2026-09-01T00:00:00Z&to=2026-09-30'],
      ['text', '?from=yesterday&to=today'],
      ['a day that does not exist', '?from=2026-02-30&to=2026-03-01'],
      ['an end before the start', '?from=2026-09-02&to=2026-09-01'],
      ['more than 92 days', '?from=2026-07-01&to=2026-10-01'],
      [
        'an include_test that is not a boolean',
        '?from=2026-09-01&to=2026-09-30&include_test=maybe',
      ],
    ])('answers 400 for %s and reads nothing', async (_label, query) => {
      await http(app)
        .get(`${ROUTE}${query}`)
        .set('Authorization', 'Bearer staff-aal2')
        .expect(400);
      expect(repository.findTemplateMetrics).not.toHaveBeenCalled();
    });

    it('names the range problem with a stable code', async () => {
      const response = await http(app)
        .get(`${ROUTE}?from=2026-07-01&to=2026-10-01`)
        .set('Authorization', 'Bearer staff-aal2')
        .expect(400);
      expect(response.body).toMatchObject({
        code: 'ADMIN_TEMPLATE_METRICS_RANGE_INVALID',
      });
    });
  });

  describe('with the control tower disabled', () => {
    let app: INestApplication;
    beforeAll(async () => {
      app = await createApp({ ADMIN_CONTROL_TOWER_ENABLED: 'false' });
    });
    afterAll(async () => app.close());

    it('answers 404 even to staff', async () => {
      await http(app)
        .get(`${ROUTE}?from=2026-09-01&to=2026-09-30`)
        .set('Authorization', 'Bearer staff-aal2')
        .expect(404);
      expect(repository.findTemplateMetrics).not.toHaveBeenCalled();
    });
  });
});
