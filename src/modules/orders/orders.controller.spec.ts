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
});
