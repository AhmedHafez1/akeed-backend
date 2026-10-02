import { HttpException } from '@nestjs/common';
import { PhoneService } from '../../shared/services/phone.service';
import {
  StandaloneIngestionAcceptanceError,
  StandaloneIngestionConflictError,
  StandaloneIngestionDispatchError,
} from '../order-ingestion/standalone-order-ingestion.errors';
import { ApiOrderChannelAdapter } from './api-order.channel-adapter';
import type { CreateApiOrderDto } from './dto/create-api-order.dto';

const adapter = new ApiOrderChannelAdapter(new PhoneService());

const dto = (overrides: Partial<CreateApiOrderDto> = {}): CreateApiOrderDto =>
  ({
    externalOrderId: '#1001',
    customerName: 'Mona Ali',
    customerPhone: '+201001234567',
    totalPrice: '450.00',
    currency: 'EGP',
    paymentMethod: 'cash_on_delivery',
    ...overrides,
  }) as CreateApiOrderDto;

function thrownBy(run: () => unknown): { status: number; body: unknown } {
  try {
    run();
  } catch (error) {
    if (error instanceof HttpException)
      return { status: error.getStatus(), body: error.getResponse() };
    throw error;
  }
  throw new Error('expected a rejection');
}

describe('ApiOrderChannelAdapter', () => {
  describe('toCanonicalOrderInput', () => {
    it('gives the order the shared reference identity and shows it as written', () => {
      expect(adapter.toCanonicalOrderInput(dto())).toEqual({
        externalOrderId: 'ref:1001',
        orderNumber: '#1001',
        customerPhone: '+201001234567',
        customerName: 'Mona Ali',
        totalPrice: '450.00',
        currency: 'EGP',
        paymentMethod: 'cash_on_delivery',
        extras: {},
      });
    });

    it.each([
      ['#1001', 'ref:1001'],
      ['# 10 01', 'ref:1001'],
      ['ORD-7', 'ref:ord-7'],
    ])('normalizes externalOrderId %j to %j', (externalOrderId, identity) => {
      const input = adapter.toCanonicalOrderInput(dto({ externalOrderId }));
      expect(input.externalOrderId).toBe(identity);
      // Only the identity is normalized; the merchant's text is what shows.
      expect(input.orderNumber).toBe(externalOrderId);
    });

    it('keeps an explicit orderNumber apart from the identity', () => {
      const input = adapter.toCanonicalOrderInput(
        dto({ externalOrderId: '8841', orderNumber: 'Web order 8841' }),
      );
      expect(input.externalOrderId).toBe('ref:8841');
      expect(input.orderNumber).toBe('Web order 8841');
    });

    it('standardizes the phone through the shared phone service', () => {
      expect(
        adapter.toCanonicalOrderInput(
          dto({ customerPhone: '+20 100 123 4567' }),
        ).customerPhone,
      ).toBe('+201001234567');
    });

    it('passes on only the optional fields the request filled', () => {
      expect(
        adapter.toCanonicalOrderInput(
          dto({
            orderDate: '2026-10-02',
            city: 'Cairo',
            address: '12 Nile St',
            notes: 'Call first',
          }),
        ).extras,
      ).toEqual({
        orderDate: '2026-10-02',
        city: 'Cairo',
        address: '12 Nile St',
        notes: 'Call first',
      });
      expect(
        adapter.toCanonicalOrderInput(
          dto({ city: 'Cairo', notes: undefined, address: null as never }),
        ).extras,
      ).toEqual({ city: 'Cairo' });
    });

    it('never carries a tenant or platform field into the command', () => {
      const input = adapter.toCanonicalOrderInput({
        ...dto(),
        orgId: 'org-forged',
        integrationId: 'int-forged',
        platform: 'shopify',
      } as never);
      expect(JSON.stringify(input)).not.toMatch(/forged|shopify/);
    });

    it.each([
      [
        'a reference with nothing in it',
        { externalOrderId: '#' },
        'externalOrderId',
      ],
      ['an unreadable phone', { customerPhone: '12345678' }, 'customerPhone'],
    ])('answers API_VALIDATION_FAILED for %s', (_case, overrides, field) => {
      const { status, body } = thrownBy(() =>
        adapter.toCanonicalOrderInput(dto(overrides)),
      );
      expect(status).toBe(400);
      expect(body).toMatchObject({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Order validation failed.',
        code: 'API_VALIDATION_FAILED',
      });
      expect(
        typeof (body as { fieldErrors: Record<string, unknown> }).fieldErrors[
          field
        ],
      ).toBe('string');
    });
  });

  describe('toResponse', () => {
    it('answers accepted with the identifiers and nothing internal', () => {
      expect(
        adapter.toResponse({
          orderId: 'order-1',
          eventId: 'event-1',
          verificationId: 'verification-1',
          duplicate: true,
          held: false,
        }),
      ).toEqual({
        orderId: 'order-1',
        verificationId: 'verification-1',
        status: 'accepted',
        duplicate: true,
      });
      expect(
        adapter.toResponse({
          orderId: 'order-1',
          eventId: 'event-1',
          duplicate: false,
          held: false,
        }),
      ).toEqual({ orderId: 'order-1', status: 'accepted', duplicate: false });
    });
  });

  describe('rethrowAsHttp', () => {
    it.each([
      [
        new StandaloneIngestionConflictError(),
        {
          statusCode: 409,
          error: 'Conflict',
          message:
            'Idempotency-Key was already used with different order data.',
          code: 'API_ORDER_IDEMPOTENCY_CONFLICT',
        },
      ],
      [
        new StandaloneIngestionAcceptanceError(),
        {
          statusCode: 503,
          error: 'Service Unavailable',
          message:
            'The order could not be durably accepted. Retry with the same Idempotency-Key.',
          code: 'API_ORDER_ACCEPTANCE_FAILED',
        },
      ],
      [
        new StandaloneIngestionDispatchError(),
        {
          statusCode: 503,
          error: 'Service Unavailable',
          message:
            'The order was saved but its verification could not be queued. Retry with the same Idempotency-Key.',
          code: 'API_ORDER_DISPATCH_FAILED',
        },
      ],
    ])('maps %s to its API response', (error, body) => {
      expect(thrownBy(() => adapter.rethrowAsHttp(error))).toEqual({
        status: body.statusCode,
        body,
      });
    });

    it('rethrows anything else untouched', () => {
      const error = new Error('unexpected');
      expect(() => adapter.rethrowAsHttp(error)).toThrow(error);
    });
  });
});
