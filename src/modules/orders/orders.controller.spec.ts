import type { Server } from 'node:http';
import { type ExecutionContext, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { SecurityMiddleware } from '../../shared/middleware/security.middleware';
import {
  DualAuthGuard,
  type AuthenticatedUser,
} from '../auth/guards/dual-auth.guard';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

function isValidationResponse(
  value: unknown,
): value is { code: string; fieldErrors: Record<string, string> } {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.code === 'string' &&
    !!record.fieldErrors &&
    typeof record.fieldErrors === 'object'
  );
}

describe('OrdersController manual order HTTP contract', () => {
  let app: INestApplication<Server>;
  const service = {
    createManualOrder: jest.fn(),
    listByOrg: jest.fn(),
    getDashboardStatsByOrg: jest.fn(),
    retryOrderVerification: jest.fn(),
  };
  const user: AuthenticatedUser = {
    userId: 'user-1',
    orgId: 'org-1',
    role: 'owner',
    source: 'supabase',
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    user.role = 'owner';
    service.createManualOrder.mockResolvedValue({
      orderId: 'order-1',
      status: 'accepted',
      duplicate: false,
    });
    service.listByOrg.mockResolvedValue({
      data: [],
      next_cursor: null,
      total_count: 0,
      page_context: {
        source: {
          status: 'connected',
          integration_id: 'int-1',
          platform_type: 'standalone',
        },
        reporting_timezone: 'Africa/Cairo',
        automation: {
          is_auto_verify_enabled: true,
          follow_up_enabled: true,
          quiet_hours_enabled: false,
        },
      },
    });
    service.getDashboardStatsByOrg.mockResolvedValue({ date_range: 'today' });
    const module = await Test.createTestingModule({
      controllers: [OrdersController],
      providers: [{ provide: OrdersService, useValue: service }],
    })
      .overrideGuard(DualAuthGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          context
            .switchToHttp()
            .getRequest<{ user: AuthenticatedUser }>().user = user;
          return true;
        },
      })
      .compile();
    app = module.createNestApplication();
    const securityMiddleware = new SecurityMiddleware(
      new ConfigService({ CORS_ALLOWED_ORIGINS: 'http://localhost:3001' }),
    );
    app.use(securityMiddleware.use.bind(securityMiddleware));
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it.each(['http://localhost:3001', 'https://test-store.myshopify.com'])(
    'allows the manual order browser preflight from %s',
    async (origin) => {
      const requestHeaders = [
        'authorization',
        'content-type',
        'idempotency-key',
        'ngrok-skip-browser-warning',
      ];
      await request(app.getHttpServer())
        .options('/api/orders')
        .set('Origin', origin)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', requestHeaders.join(', '))
        .expect(200)
        .expect('Access-Control-Allow-Origin', origin)
        .expect('Access-Control-Allow-Credentials', 'true')
        .expect('Access-Control-Allow-Methods', /\bPOST\b/)
        .expect((response) => {
          const allowedHeaders = response.get('Access-Control-Allow-Headers');
          expect(allowedHeaders?.toLowerCase().split(/,\s*/)).toEqual(
            expect.arrayContaining(requestHeaders),
          );
        });
      expect(service.createManualOrder).not.toHaveBeenCalled();
    },
  );

  it('does not allow a preflight from an untrusted origin', async () => {
    await request(app.getHttpServer())
      .options('/api/orders')
      .set('Origin', 'https://untrusted.example')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'idempotency-key')
      .expect(200)
      .expect((response) => {
        expect(response.get('Access-Control-Allow-Origin')).toBeUndefined();
      });
    expect(service.createManualOrder).not.toHaveBeenCalled();
  });

  it('returns 202 accepted and strips forged authority fields', async () => {
    await request(app.getHttpServer())
      .post('/api/orders')
      .set('Origin', 'http://localhost:3001')
      .set('Idempotency-Key', 'submission-key-123')
      .send({
        customerPhone: ' +201001234567 ',
        customerName: ' Customer ',
        orderNumber: ' ORD-1 ',
        totalPrice: '125.50',
        currency: 'egp',
        paymentMethod: 'CASH_ON_DELIVERY',
        orgId: 'org-forged',
        integrationId: 'int-forged',
        externalOrderId: 'order-forged',
        role: 'owner',
        billingStatus: 'active',
        isActive: true,
      })
      .expect('Access-Control-Allow-Origin', 'http://localhost:3001')
      .expect(202, {
        orderId: 'order-1',
        status: 'accepted',
        duplicate: false,
      });

    expect(service.createManualOrder).toHaveBeenCalledWith(
      user,
      'submission-key-123',
      {
        customerPhone: '+201001234567',
        customerName: 'Customer',
        orderNumber: 'ORD-1',
        totalPrice: '125.50',
        currency: 'EGP',
        paymentMethod: 'cash on delivery',
      },
    );
  });

  it.each([
    [{}, ['customerPhone', 'totalPrice', 'currency', 'paymentMethod']],
    [
      {
        customerPhone: 'bad',
        totalPrice: '0.00',
        currency: 'XYZ',
        paymentMethod: '',
      },
      ['customerPhone', 'totalPrice', 'currency', 'paymentMethod'],
    ],
  ])(
    'returns stable field errors before calling the service',
    async (body, fields) => {
      const response = await request(app.getHttpServer())
        .post('/api/orders')
        .set('Idempotency-Key', 'submission-key-123')
        .send(body)
        .expect(400);
      const responseBody = response.body as unknown;
      expect(isValidationResponse(responseBody)).toBe(true);
      if (!isValidationResponse(responseBody)) {
        throw new Error('Expected a manual-order validation response');
      }
      expect(responseBody.code).toBe('MANUAL_ORDER_VALIDATION_FAILED');
      expect(Object.keys(responseBody.fieldErrors)).toEqual(
        expect.arrayContaining(fields),
      );
      expect(service.createManualOrder).not.toHaveBeenCalled();
    },
  );

  it('validates and forwards list filters with owner action permissions', async () => {
    const response = await request(app.getHttpServer())
      .get(
        '/api/orders?date_range=today&status=accepted%2Cconfirmed&cursor=cursor-1&limit=25',
      )
      .expect(200);

    expect(service.listByOrg).toHaveBeenCalledWith('org-1', {
      date_range: 'today',
      status: 'accepted,confirmed',
      cursor: 'cursor-1',
      limit: 25,
    });
    expect(response.body as unknown).toMatchObject({
      page_context: {
        permissions: {
          can_send_test_verification: true,
          can_cancel_orders: true,
          can_create_manual_order: true,
          can_retry_verifications: true,
        },
      },
    });
  });

  it('keeps viewers read-only in page context', async () => {
    user.role = 'viewer';

    const response = await request(app.getHttpServer())
      .get('/api/orders')
      .expect(200);

    expect(response.body as unknown).toMatchObject({
      page_context: {
        permissions: {
          can_send_test_verification: false,
          can_cancel_orders: false,
          can_create_manual_order: false,
          can_retry_verifications: false,
        },
      },
    });
  });

  it.each([
    ['/api/orders?date_range=week'],
    ['/api/orders?limit=0'],
    ['/api/orders?limit=101'],
  ])('rejects invalid list query %s', async (url) => {
    await request(app.getHttpServer()).get(url).expect(400);
    expect(service.listByOrg).not.toHaveBeenCalled();
  });

  it('returns standalone stats for the selected reporting range', async () => {
    service.getDashboardStatsByOrg.mockResolvedValueOnce({
      date_range: 'last_7_days',
    });
    await request(app.getHttpServer())
      .get('/api/orders/stats?date_range=last_7_days')
      .expect(200, { stats: { date_range: 'last_7_days' } });

    expect(service.getDashboardStatsByOrg).toHaveBeenCalledWith(
      'org-1',
      'last_7_days',
    );
  });
});
