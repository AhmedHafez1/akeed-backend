import {
  StandaloneIngestionAcceptanceError,
  StandaloneIngestionConflictError,
  StandaloneIngestionDispatchError,
} from '../order-ingestion/standalone-order-ingestion.errors';
import { ManualOrderChannelAdapter } from './manual-order.channel-adapter';

describe('ManualOrderChannelAdapter', () => {
  it('translates the form into a canonical order with the manual identity', () => {
    expect(
      ManualOrderChannelAdapter.toCanonicalOrderInput(
        {
          customerPhone: '01001234567',
          customerName: 'Customer',
          orderNumber: 'ORD-1',
          totalPrice: '10',
          currency: 'EGP',
          paymentMethod: 'cash on delivery',
        },
        { idempotencyKey: 'golden-key-0001', customerPhone: '+201001234567' },
      ),
    ).toEqual({
      externalOrderId: 'manual-225d61818928270d2113c286a31e8e16c3b59676',
      orderNumber: 'ORD-1',
      customerPhone: '+201001234567',
      customerName: 'Customer',
      totalPrice: '10',
      currency: 'EGP',
      paymentMethod: 'cash on delivery',
    });
  });

  it.each([
    [
      new StandaloneIngestionConflictError(),
      {
        statusCode: 409,
        error: 'Conflict',
        message: 'Idempotency-Key was already used with different order data.',
        code: 'MANUAL_ORDER_IDEMPOTENCY_CONFLICT',
      },
    ],
    [
      new StandaloneIngestionAcceptanceError(),
      {
        statusCode: 503,
        error: 'Service Unavailable',
        message: 'The order could not be durably accepted. Retry safely.',
        code: 'MANUAL_ORDER_ACCEPTANCE_FAILED',
      },
    ],
    [
      new StandaloneIngestionDispatchError(),
      {
        statusCode: 503,
        error: 'Service Unavailable',
        message:
          'The order was saved but its verification could not be queued. Retry safely.',
        code: 'MANUAL_ORDER_DISPATCH_FAILED',
      },
    ],
  ])('maps %s to the unchanged manual response', (error, body) => {
    let thrown: unknown;
    try {
      ManualOrderChannelAdapter.rethrowAsHttp(error);
    } catch (caught) {
      thrown = caught;
    }
    expect(thrown).toMatchObject({ status: body.statusCode, response: body });
  });

  it('rethrows anything else untouched', () => {
    const error = new Error('unexpected');
    expect(() => ManualOrderChannelAdapter.rethrowAsHttp(error)).toThrow(error);
  });
});
