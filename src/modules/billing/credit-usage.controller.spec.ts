import { Test } from '@nestjs/testing';
import { type ExecutionContext, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { CreditUsageController } from './credit-usage.controller';
import { CreditUsageService } from './credit-usage.service';
import { CreditUsageRepository } from '../../infrastructure/database/repositories/credit-usage.repository';
import { DualAuthGuard } from '../auth/guards/dual-auth.guard';
import { BILLING_ERROR_CODES } from './billing.types';

describe('GET credit usage', () => {
  let app: INestApplication;
  const read = jest.fn().mockResolvedValue({ usedThisMonth: 3 });
  let authenticated = true;
  let role = 'viewer';
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [CreditUsageController],
      providers: [
        CreditUsageService,
        { provide: CreditUsageRepository, useValue: { read } },
      ],
    })
      .overrideGuard(DualAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          if (!authenticated) return false;
          context.switchToHttp().getRequest<{ user: unknown }>().user = {
            orgId: 'tenant-a',
            role,
          };
          return true;
        },
      })
      .compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(() => app.close());
  beforeEach(() => {
    read.mockClear();
    authenticated = true;
  });

  it.each(['owner', 'admin', 'viewer'])(
    'permits a %s read using the authenticated tenant only',
    async (value) => {
      role = value;
      await request(app.getHttpServer() as Parameters<typeof request>[0])
        .get(
          '/api/billing/credits/usage?timeZone=Africa%2FCairo&orgId=tenant-b',
        )
        .expect(200)
        .expect('Cache-Control', 'private, no-store');
      expect(read).toHaveBeenCalledWith(
        'tenant-a',
        'Africa/Cairo',
        expect.any(String),
      );
    },
  );
  it('rejects an invalid timezone without echoing input', async () => {
    const response = await request(
      app.getHttpServer() as Parameters<typeof request>[0],
    )
      .get('/api/billing/credits/usage?timeZone=untrusted-value')
      .expect(400);
    expect(response.body).toMatchObject({
      code: BILLING_ERROR_CODES.validationFailed,
    });
    expect(JSON.stringify(response.body)).not.toContain('untrusted-value');
    expect(read).not.toHaveBeenCalled();
  });
  it('requires authentication', async () => {
    authenticated = false;
    await request(app.getHttpServer() as Parameters<typeof request>[0])
      .get('/api/billing/credits/usage')
      .expect(403);
    expect(read).not.toHaveBeenCalled();
  });
});
