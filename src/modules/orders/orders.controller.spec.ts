import type { Server } from 'node:http';
import { type ExecutionContext, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
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
  };
  const user: AuthenticatedUser = {
    userId: 'user-1',
    orgId: 'org-1',
    role: 'owner',
    source: 'supabase',
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    service.createManualOrder.mockResolvedValue({
      orderId: 'order-1',
      status: 'accepted',
      duplicate: false,
    });
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
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 202 accepted and strips forged authority fields', async () => {
    await request(app.getHttpServer())
      .post('/api/orders')
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
