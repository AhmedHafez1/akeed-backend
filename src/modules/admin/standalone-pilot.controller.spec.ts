import { randomUUID } from 'node:crypto';
import {
  ForbiddenException,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AdminAccessGuard } from './admin-access.guard';
import { StandalonePilotController } from './standalone-pilot.controller';
import { StandalonePilotService } from './standalone-pilot.service';
import { TokenValidatorService } from '../auth/services/token-validator.service';
import { AdminAccessAuditRepository } from '../../infrastructure/database/repositories/admin-access-audit.repository';

describe('Standalone pilot staff HTTP boundary', () => {
  let app: INestApplication;
  const staffId = randomUUID();
  const orgId = randomUUID();
  const previewId = randomUUID();
  const pilots = {
    list: jest.fn().mockResolvedValue({ rows: [] }),
    preview: jest.fn().mockResolvedValue({ previewId }),
    apply: jest.fn().mockResolvedValue({ results: [] }),
  };
  const http = () =>
    request(app.getHttpServer() as Parameters<typeof request>[0]);
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [StandalonePilotController],
      providers: [
        AdminAccessGuard,
        { provide: StandalonePilotService, useValue: pilots },
        {
          provide: ConfigService,
          useValue: new ConfigService({ ADMIN_CONTROL_TOWER_ENABLED: 'true' }),
        },
        {
          provide: AdminAccessAuditRepository,
          useValue: { record: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: TokenValidatorService,
          useValue: {
            validateAdminToken: jest.fn((token: string) => {
              if (token !== 'staff-aal2')
                throw new ForbiddenException('Staff MFA required');
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
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });
  afterAll(async () => app.close());
  beforeEach(() => jest.clearAllMocks());
  it.each([
    'merchant-owner',
    'organization-admin',
    'viewer',
    'shopify',
    'staff-aal1',
  ])('denies %s', async (token) => {
    await http()
      .post('/api/admin/standalone-pilots/apply')
      .set('Authorization', `Bearer ${token}`)
      .send({ previewId, reason: 'Pilot' })
      .expect(403);
    expect(pilots.apply).not.toHaveBeenCalled();
  });
  it('requires authentication even for discovery', async () => {
    await http().get('/api/admin/standalone-pilots').expect(401);
  });
  it('uses the guard principal and never accepts actor, plan or billing overrides', async () => {
    await http()
      .post('/api/admin/standalone-pilots/apply')
      .set('Authorization', 'Bearer staff-aal2')
      .send({
        previewId,
        reason: '  Approved pilot  ',
        userId: randomUUID(),
        billingPlanId: 'business',
        organizationIds: [orgId],
      })
      .expect(201);
    expect(pilots.apply).toHaveBeenCalledWith(
      staffId,
      previewId,
      'Approved pilot',
    );
  });
  it.each([
    { organizationIds: [] },
    { organizationIds: Array.from({ length: 51 }, () => randomUUID()) },
    { organizationIds: [orgId, orgId] },
    { organizationIds: ['not-a-uuid'] },
  ])('rejects invalid preview selection', async ({ organizationIds }) => {
    await http()
      .post('/api/admin/standalone-pilots/preview')
      .set('Authorization', 'Bearer staff-aal2')
      .send({ organizationIds })
      .expect(400);
    expect(pilots.preview).not.toHaveBeenCalled();
  });
  it('accepts an explicit selection and prevents caching', async () => {
    const response = await http()
      .post('/api/admin/standalone-pilots/preview')
      .set('Authorization', 'Bearer staff-aal2')
      .send({ organizationIds: [orgId] })
      .expect(201);
    expect(pilots.preview).toHaveBeenCalledWith(staffId, [orgId]);
    expect(response.headers['cache-control']).toBe('private, no-store');
  });
  it.each(['', '   ', 'x'.repeat(501)])(
    'requires a bounded meaningful reason',
    async (reason) => {
      await http()
        .post('/api/admin/standalone-pilots/apply')
        .set('Authorization', 'Bearer staff-aal2')
        .send({ previewId, reason })
        .expect(400);
    },
  );
});
