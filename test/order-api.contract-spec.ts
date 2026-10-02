import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  creditReservations,
  orders,
  verificationMessageDispatches,
  verifications,
  webhookEvents,
} from '../src/infrastructure/database/schema';
import { ApiOrderChannelAdapter } from '../src/modules/order-api/api-order.channel-adapter';
import {
  createApiOrderPipe,
  OrderApiController,
} from '../src/modules/order-api/order-api.controller';
import type { CreateApiOrderDto } from '../src/modules/order-api/dto/create-api-order.dto';
import { CreateManualOrderDto } from '../src/modules/orders/dto/create-manual-order.dto';
import { PhoneService } from '../src/shared/services/phone.service';
import { plainToInstance } from 'class-transformer';
import {
  releaseGateHarness,
  type ReleaseGateHarness,
} from './contracts/release-gate-harness';

const gate = releaseGateHarness();
type Merchant = Awaited<ReturnType<ReleaseGateHarness['merchant']>>;

const controller = new OrderApiController(
  gate.services.ingestion,
  new ApiOrderChannelAdapter(new PhoneService()),
);

/** The principal `IntegrationApiKeyGuard` attaches for a key of this source. */
function keyOf(merchant: Merchant, integrationId = merchant.integrationId) {
  return {
    orgId: merchant.orgId,
    integrationId,
    keyId: randomUUID(),
    prefix: 'ak_live_contract',
  };
}

/** One request as the route handles it: the route pipe, then the controller. */
async function submit(
  merchant: Merchant,
  body: Record<string, unknown>,
  idempotencyKey: string,
  principal = keyOf(merchant),
) {
  const dto = (await createApiOrderPipe.transform(body, {
    type: 'body',
    metatype: Object,
    data: '',
  })) as CreateApiOrderDto;
  return controller.create(principal, idempotencyKey, dto);
}

const order = (overrides: Record<string, unknown> = {}) => ({
  externalOrderId: `#${Math.floor(Math.random() * 1e9)}`,
  customerName: 'Mona Ali',
  customerPhone: '+201001234567',
  totalPrice: '450',
  currency: 'EGP',
  paymentMethod: 'cod',
  ...overrides,
});

async function stateOf(orgId: string) {
  const [orderRows, eventRows, verificationRows, dispatchRows, holdRows] =
    await Promise.all([
      gate.db.select().from(orders).where(eq(orders.orgId, orgId)),
      gate.db
        .select()
        .from(webhookEvents)
        .where(eq(webhookEvents.orgId, orgId)),
      gate.db
        .select()
        .from(verifications)
        .where(eq(verifications.orgId, orgId)),
      gate.db
        .select({ id: verificationMessageDispatches.id })
        .from(verificationMessageDispatches)
        .where(eq(verificationMessageDispatches.orgId, orgId)),
      gate.db
        .select({ id: creditReservations.id })
        .from(creditReservations)
        .where(eq(creditReservations.orgId, orgId)),
    ]);
  return {
    orders: orderRows,
    events: eventRows,
    verifications: verificationRows,
    dispatches: dispatchRows.length,
    creditHolds: holdRows.length,
  };
}

async function codeOf(attempt: Promise<unknown>): Promise<string> {
  try {
    await attempt;
  } catch (error) {
    const response = (
      error as { getResponse?: () => { code?: string } }
    ).getResponse?.();
    if (response?.code) return response.code;
    throw error;
  }
  throw new Error('expected a refusal');
}

/**
 * US-05-02 over PostgreSQL: an API order goes through the same ingestion
 * command, event, normalizer, eligibility, hub and send path as a manual
 * order. Real repositories and services; only the messaging port and the
 * queues are fakes (see `releaseGateHarness`).
 */
describe('order API PostgreSQL contract (US-05-02)', () => {
  beforeAll(() => gate.setup());
  afterAll(() => gate.teardown());

  it('a COD order is stored once, tagged as the api channel, and sent like a manual order', async () => {
    const merchant = await gate.merchant();
    const sendsBefore = gate.sends.length;
    const key = `order-${randomUUID()}`;

    const answer = await submit(
      merchant,
      order({ externalOrderId: ' #A-1001 ', notes: 'Call first' }),
      key,
    );
    expect(answer).toMatchObject({ status: 'accepted', duplicate: false });
    await gate.drain();

    const state = await stateOf(merchant.orgId);
    expect(state.orders).toHaveLength(1);
    expect(state.orders[0]).toMatchObject({
      id: answer.orderId,
      integrationId: merchant.integrationId,
      externalOrderId: 'ref:a-1001',
      orderNumber: '#A-1001',
      customerPhone: '+201001234567',
      totalPrice: '450.00',
      currency: 'EGP',
      isTest: false,
    });
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({
      platform: 'standalone',
      jobType: 'order.create',
      idempotencyKey: `api:${key}`,
      storeDomain: `standalone:${merchant.orgId}`,
      integrationId: merchant.integrationId,
      orderId: answer.orderId,
      status: 'completed',
    });
    expect(state.events[0].rawPayload).toMatchObject({
      ingestionType: 'api',
      order: { notes: 'Call first', codStatus: 'cod' },
    });
    // The credential is never stored with the order or its event.
    expect(JSON.stringify([state.orders, state.events])).not.toContain(
      'ak_live_contract',
    );

    expect(state.verifications).toHaveLength(1);
    expect(state.verifications[0]).toMatchObject({
      orderId: answer.orderId,
      status: 'sent',
    });
    expect(state.creditHolds).toBe(1);
    expect(
      gate.sends.slice(sendsBefore).map((send) => ({
        to: send.to,
        orderNumber: send.orderNumber,
        verificationId: send.verificationId,
      })),
    ).toEqual([
      {
        to: '+201001234567',
        orderNumber: '#A-1001',
        verificationId: state.verifications[0].id,
      },
    ]);
  });

  it('an API order and a manual order of the same content are processed identically', async () => {
    const viaApi = await gate.merchant();
    const viaManual = await gate.merchant();

    await submit(
      viaApi,
      order({ externalOrderId: 'EQ-1', paymentMethod: 'cash_on_delivery' }),
      `order-${randomUUID()}`,
    );
    await gate.services.orders.createManualOrder(
      viaManual.user,
      `manual-${randomUUID()}`,
      plainToInstance(CreateManualOrderDto, {
        customerPhone: '+201001234567',
        customerName: 'Mona Ali',
        orderNumber: 'EQ-1',
        totalPrice: '450',
        currency: 'EGP',
        paymentMethod: 'cash_on_delivery',
      }),
    );
    await gate.drain();

    const [api, manual] = await Promise.all([
      stateOf(viaApi.orgId),
      stateOf(viaManual.orgId),
    ]);
    const shape = (state: Awaited<ReturnType<typeof stateOf>>) => ({
      order: {
        orderNumber: state.orders[0].orderNumber,
        customerPhone: state.orders[0].customerPhone,
        customerName: state.orders[0].customerName,
        totalPrice: state.orders[0].totalPrice,
        currency: state.orders[0].currency,
        paymentMethod: state.orders[0].paymentMethod,
      },
      eventStatus: state.events[0].status,
      verificationStatus: state.verifications[0]?.status,
      dispatches: state.dispatches,
      creditHolds: state.creditHolds,
    });
    expect(shape(api)).toEqual(shape(manual));
    expect(shape(api)).toMatchObject({
      verificationStatus: 'sent',
      dispatches: 1,
      creditHolds: 1,
    });
  });

  it('a known non-COD order is accepted and visible but never sent', async () => {
    const merchant = await gate.merchant();
    const sendsBefore = gate.sends.length;

    const answer = await submit(
      merchant,
      order({ externalOrderId: 'PAID-1', paymentMethod: 'Credit Card' }),
      `order-${randomUUID()}`,
    );
    expect(answer).toEqual({
      orderId: answer.orderId,
      status: 'accepted',
      duplicate: false,
    });
    await gate.drain();

    const state = await stateOf(merchant.orgId);
    expect(state.orders).toHaveLength(1);
    expect(state.orders[0]).toMatchObject({
      externalOrderId: 'ref:paid-1',
      paymentMethod: 'credit card',
    });
    expect(state.events[0]).toMatchObject({
      status: 'skipped',
      lastError: 'non_cod_payment_method',
    });
    expect(state.verifications).toEqual([]);
    expect(state.dispatches).toBe(0);
    expect(state.creditHolds).toBe(0);
    expect(gate.sends.length).toBe(sendsBefore);

    // Visible where the merchant looks for it: the dashboard projection.
    const projected = await gate.repositories.orders.findDashboardOrderById(
      answer.orderId,
      merchant.orgId,
    );
    expect(projected).toMatchObject({
      id: answer.orderId,
      externalOrderId: 'ref:paid-1',
      verificationId: null,
      retryGuardStatus: 'ineligible',
    });
  });

  it('the same Idempotency-Key with different content is a conflict and changes nothing', async () => {
    const merchant = await gate.merchant();
    const key = `order-${randomUUID()}`;
    await submit(merchant, order({ externalOrderId: 'C-1' }), key);
    await gate.drain();
    const before = await stateOf(merchant.orgId);

    await expect(
      codeOf(
        submit(
          merchant,
          order({ externalOrderId: 'C-1', totalPrice: '999' }),
          key,
        ),
      ),
    ).resolves.toBe('API_ORDER_IDEMPOTENCY_CONFLICT');
    await gate.drain();

    const after = await stateOf(merchant.orgId);
    expect(after.orders).toEqual(before.orders);
    expect(after.events).toHaveLength(1);
    expect(after.verifications).toHaveLength(1);
    expect(after.dispatches).toBe(before.dispatches);
    expect(after.creditHolds).toBe(before.creditHolds);
  });

  it('a retry with the same key and content never creates a second order, event or send', async () => {
    // What the retry answers after the first dispatch is US-05-03's subject
    // (replay semantics); this pins only that it has no second effect.
    const merchant = await gate.merchant();
    const key = `order-${randomUUID()}`;
    const body = order({ externalOrderId: 'R-1' });
    const first = await submit(merchant, body, key);
    await gate.drain();
    const sendsAfterFirst = gate.sends.length;

    await submit(merchant, body, key).then(
      (answer) => expect(answer.orderId).toBe(first.orderId),
      () => undefined,
    );
    await gate.drain();

    const state = await stateOf(merchant.orgId);
    expect(state.orders).toHaveLength(1);
    expect(state.events).toHaveLength(1);
    expect(state.verifications).toHaveLength(1);
    expect(state.dispatches).toBe(1);
    expect(state.creditHolds).toBe(1);
    expect(gate.sends.length).toBe(sendsAfterFirst);
  });

  it('an API key and a manual submission may use the same key text without colliding', async () => {
    const merchant = await gate.merchant();
    const key = `shared-${randomUUID()}`;
    await submit(merchant, order({ externalOrderId: 'N-1' }), key);
    await gate.services.orders.createManualOrder(
      merchant.user,
      key,
      plainToInstance(CreateManualOrderDto, {
        customerPhone: '+201001234568',
        customerName: 'Walk In',
        orderNumber: 'N-2',
        totalPrice: '100',
        currency: 'EGP',
        paymentMethod: 'cash_on_delivery',
      }),
    );
    await gate.drain();

    const state = await stateOf(merchant.orgId);
    expect(state.orders).toHaveLength(2);
    expect(state.events.map((event) => event.idempotencyKey).sort()).toEqual(
      [key, `api:${key}`].sort(),
    );
  });

  describe('refusals have no business effect', () => {
    async function expectNothingStored(orgId: string) {
      const state = await stateOf(orgId);
      expect(state.orders).toEqual([]);
      expect(state.events).toEqual([]);
      expect(state.verifications).toEqual([]);
      expect(state.creditHolds).toBe(0);
    }

    it('a key bound to the source of another organization cannot write into either', async () => {
      const merchant = await gate.merchant();
      const other = await gate.merchant();

      await expect(
        codeOf(
          submit(
            merchant,
            order(),
            `order-${randomUUID()}`,
            keyOf(merchant, other.integrationId),
          ),
        ),
      ).resolves.toBe('API_SOURCE_UNAVAILABLE');

      await expectNothingStored(merchant.orgId);
      await expectNothingStored(other.orgId);
    });

    it('an unfinished source answers API_SETUP_INCOMPLETE', async () => {
      const merchant = await gate.merchant();
      await gate.client`
        UPDATE integrations SET onboarding_status = 'pending'
        WHERE id = ${merchant.integrationId}`;

      await expect(
        codeOf(submit(merchant, order(), `order-${randomUUID()}`)),
      ).resolves.toBe('API_SETUP_INCOMPLETE');
      await expectNothingStored(merchant.orgId);
    });

    it('a deactivated source answers API_SOURCE_UNAVAILABLE', async () => {
      const merchant = await gate.merchant();
      await gate.client`
        UPDATE integrations SET is_active = false
        WHERE id = ${merchant.integrationId}`;

      await expect(
        codeOf(submit(merchant, order(), `order-${randomUUID()}`)),
      ).resolves.toBe('API_SOURCE_UNAVAILABLE');
      await expectNothingStored(merchant.orgId);
    });

    it('automatic verification switched off answers API_AUTO_VERIFY_DISABLED', async () => {
      const merchant = await gate.merchant({
        settings: { isAutoVerifyEnabled: false },
      });

      await expect(
        codeOf(submit(merchant, order(), `order-${randomUUID()}`)),
      ).resolves.toBe('API_AUTO_VERIFY_DISABLED');
      await expectNothingStored(merchant.orgId);
    });

    it('a used-up credit balance answers the E04.5 code unchanged', async () => {
      const merchant = await gate.merchant({ credits: 1 });
      await submit(merchant, order(), `order-${randomUUID()}`);
      await gate.drain();
      const before = await stateOf(merchant.orgId);
      expect(before.creditHolds).toBe(1);

      await expect(
        codeOf(submit(merchant, order(), `order-${randomUUID()}`)),
      ).resolves.toBe('INSUFFICIENT_CREDITS');

      const after = await stateOf(merchant.orgId);
      expect(after.orders).toHaveLength(1);
      expect(after.events).toHaveLength(1);
      expect(after.creditHolds).toBe(1);
    });

    it('an invalid body is refused before any read', async () => {
      const merchant = await gate.merchant();

      await expect(
        codeOf(
          submit(
            merchant,
            order({ orgId: randomUUID() }),
            `order-${randomUUID()}`,
          ),
        ),
      ).resolves.toBe('API_VALIDATION_FAILED');
      await expectNothingStored(merchant.orgId);
    });
  });

  it('keeps the API orders of each organization apart', async () => {
    const first = await gate.merchant();
    const second = await gate.merchant();
    const key = `order-${randomUUID()}`;
    const body = order({ externalOrderId: 'SAME-1' });

    // The same key and the same external id in two sources: two orders.
    const [a, b] = [
      await submit(first, body, key),
      await submit(second, body, key),
    ];
    await gate.drain();

    expect(a.orderId).not.toBe(b.orderId);
    const [stateA, stateB] = await Promise.all([
      stateOf(first.orgId),
      stateOf(second.orgId),
    ]);
    expect(stateA.orders.map((row) => row.id)).toEqual([a.orderId]);
    expect(stateB.orders.map((row) => row.id)).toEqual([b.orderId]);
    const crossed = await gate.db
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.orgId, first.orgId),
          eq(orders.integrationId, second.integrationId),
        ),
      );
    expect(crossed).toEqual([]);
  });
});
