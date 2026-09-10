import type {
  NormalizedProviderEvent,
  PaymentInquiryResult,
} from '../../shared/ports/payments.port';
import { PaymentReconciliationService } from './payment-reconciliation.service';

const REFERENCE = 'akd_1111111111111111111111111111aaaa';
const PAST = '2026-09-09T09:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';

const providerEvent: NormalizedProviderEvent = {
  provider: 'paymob',
  source: 'inquiry',
  reference: REFERENCE,
  signal: 'success',
  payment: { reference: REFERENCE, providerTransactionId: 'txn_1' },
  amountMinor: 20000,
  currency: 'EGP',
  integrationId: 'card1',
  mode: 'test',
  fingerprint: 'a'.repeat(64),
  payloadHash: 'b'.repeat(64),
};

function target(overrides: Record<string, unknown> = {}) {
  return {
    id: 'purchase-1',
    orgId: 'org-1',
    reference: REFERENCE,
    mode: 'test',
    currency: 'EGP',
    status: 'pending',
    checkoutExpiresAt: PAST,
    reconciliationRequired: false,
    reconciliationAttempts: 0,
    nextReconciliationAt: null,
    providerIntentionId: null,
    providerOrderId: 'ord_1',
    providerTransactionId: null,
    ...overrides,
  };
}

function setup(
  overrides: {
    target?: Record<string, unknown> | null;
    inquiry?: PaymentInquiryResult;
    inquireError?: Error;
  } = {},
) {
  const purchases = {
    findReconciliationTarget: jest
      .fn()
      .mockResolvedValue(
        overrides.target === null ? undefined : target(overrides.target),
      ),
    updatePurchase: jest.fn().mockResolvedValue({}),
  };
  const callbacks = {
    ingest: jest
      .fn()
      .mockResolvedValue({ outcome: 'granted', resultCode: 'granted' }),
  };
  const payments = {
    inquire: overrides.inquireError
      ? jest.fn().mockRejectedValue(overrides.inquireError)
      : jest.fn().mockResolvedValue(
          overrides.inquiry ?? {
            outcome: 'found',
            payment: { reference: REFERENCE },
            mode: 'test',
            status: 'successful',
            disputeStatus: 'none',
            totalMinor: 20000,
            currency: 'EGP',
            refundedMinor: 0,
            event: providerEvent,
          },
        ),
    createCheckout: jest.fn(),
  };
  const db = { transaction: (work: (tx: unknown) => unknown) => work({}) };
  const service = new PaymentReconciliationService(
    db as never,
    purchases as never,
    callbacks as never,
    payments as never,
  );
  return { service, purchases, callbacks, payments };
}

describe('PaymentReconciliationService.reconcile', () => {
  it('feeds a found transaction through the same ingestion a callback uses', async () => {
    // Identical fingerprints are what make a recovered callback and the real
    // one collapse into a single grant.
    const { service, callbacks } = setup();
    await expect(service.reconcile('org-1', REFERENCE)).resolves.toMatchObject({
      outcome: 'resolved',
      ingest: { outcome: 'granted' },
    });
    expect(callbacks.ingest).toHaveBeenCalledWith(providerEvent);
  });

  it('passes the provider identifiers it already has', async () => {
    const { service, payments } = setup();
    await service.reconcile('org-1', REFERENCE);
    expect(payments.inquire).toHaveBeenCalledWith({
      reference: REFERENCE,
      providerIntentionId: undefined,
      providerOrderId: 'ord_1',
      providerTransactionId: undefined,
    });
  });

  it.each([
    ['a purchase that no longer exists', null],
    ['a settled purchase', { status: 'successful' }],
    ['a failed purchase', { status: 'failed' }],
    [
      'a purchase still inside its checkout window',
      { checkoutExpiresAt: FUTURE },
    ],
  ])('does not ask about %s', async (_label, overrides) => {
    const { service, payments } = setup({ target: overrides });
    await expect(service.reconcile('org-1', REFERENCE)).resolves.toMatchObject({
      outcome: 'not_eligible',
    });
    expect(payments.inquire).not.toHaveBeenCalled();
  });

  it('asks about a flagged purchase even before its window closes', async () => {
    const { service, payments } = setup({
      target: { checkoutExpiresAt: FUTURE, reconciliationRequired: true },
    });
    await service.reconcile('org-1', REFERENCE);
    expect(payments.inquire).toHaveBeenCalled();
  });

  it('rate limits repeated polling through the stored backoff', async () => {
    const { service, payments } = setup({
      target: { nextReconciliationAt: FUTURE },
    });
    await expect(service.reconcile('org-1', REFERENCE)).resolves.toMatchObject({
      outcome: 'not_due',
    });
    expect(payments.inquire).not.toHaveBeenCalled();
  });

  it('expires a stale purchase only once the provider reports no record', async () => {
    const { service, callbacks } = setup({
      inquiry: { outcome: 'not_found', code: 'not_found' },
    });
    await expect(service.reconcile('org-1', REFERENCE)).resolves.toMatchObject({
      outcome: 'expired',
    });
    const [event] = callbacks.ingest.mock.calls[0] as [NormalizedProviderEvent];
    expect(event).toMatchObject({
      signal: 'expiry_confirmed',
      source: 'inquiry',
      reference: REFERENCE,
    });
    expect(event.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('confirms expiry in the purchase mode and currency, not a test default', async () => {
    const { service, callbacks } = setup({
      target: { mode: 'live', currency: 'EGP' },
      inquiry: { outcome: 'not_found', code: 'not_found' },
    });
    await service.reconcile('org-1', REFERENCE);
    const [event] = callbacks.ingest.mock.calls[0] as [NormalizedProviderEvent];
    expect(event).toMatchObject({
      provider: 'akeed',
      mode: 'live',
      currency: 'EGP',
      amountMinor: 0,
      integrationId: 'akeed_inquiry',
      payment: { reference: REFERENCE },
    });
  });

  it('never expires a purchase whose checkout window is still open', async () => {
    const { service, callbacks } = setup({
      target: { checkoutExpiresAt: FUTURE, reconciliationRequired: true },
      inquiry: { outcome: 'not_found', code: 'not_found' },
    });
    await expect(service.reconcile('org-1', REFERENCE)).resolves.toMatchObject({
      outcome: 'deferred',
    });
    expect(callbacks.ingest).not.toHaveBeenCalled();
  });

  it('confirms the same expiry as one event, however often it is asked', async () => {
    const { service, callbacks } = setup({
      inquiry: { outcome: 'not_found', code: 'not_found' },
    });
    await service.reconcile('org-1', REFERENCE);
    await service.reconcile('org-1', REFERENCE);
    const [first] = callbacks.ingest.mock.calls[0] as [NormalizedProviderEvent];
    const [second] = callbacks.ingest.mock.calls[1] as [
      NormalizedProviderEvent,
    ];
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it('backs off without concluding anything when the provider cannot say', async () => {
    const { service, callbacks, purchases } = setup({
      inquiry: { outcome: 'unknown', code: 'provider_unavailable' },
    });
    await expect(service.reconcile('org-1', REFERENCE)).resolves.toMatchObject({
      outcome: 'deferred',
    });
    expect(callbacks.ingest).not.toHaveBeenCalled();
    const [, , , expected, changes] = purchases.updatePurchase.mock
      .calls[0] as [
      unknown,
      string,
      string,
      string,
      { reconciliationAttempts: number; nextReconciliationAt: string },
    ];
    expect(expected).toBe('pending');
    expect(changes.reconciliationAttempts).toBe(1);
    expect(Date.parse(changes.nextReconciliationAt)).toBeGreaterThan(
      Date.now(),
    );
  });

  it('lengthens the wait as attempts accumulate', async () => {
    const { service: early, purchases: earlyRepo } = setup({
      inquiry: { outcome: 'unknown', code: 'provider_unavailable' },
    });
    const { service: late, purchases: lateRepo } = setup({
      target: { reconciliationAttempts: 6 },
      inquiry: { outcome: 'unknown', code: 'provider_unavailable' },
    });
    await early.reconcile('org-1', REFERENCE);
    await late.reconcile('org-1', REFERENCE);
    const nextOf = (repo: { updatePurchase: jest.Mock }) =>
      Date.parse(
        (
          repo.updatePurchase.mock.calls[0] as [
            unknown,
            string,
            string,
            string,
            { nextReconciliationAt: string },
          ]
        )[4].nextReconciliationAt,
      );
    expect(nextOf(lateRepo)).toBeGreaterThan(nextOf(earlyRepo));
  });

  it('defers rather than failing when the provider call throws', async () => {
    const { service, purchases } = setup({
      inquireError: new Error('socket hang up'),
    });
    await expect(service.reconcile('org-1', REFERENCE)).resolves.toMatchObject({
      outcome: 'deferred',
    });
    expect(purchases.updatePurchase).toHaveBeenCalled();
  });
});

describe('PaymentReconciliationService.reconcile forced by staff', () => {
  it('asks about a pending purchase inside its window and ignores the backoff', async () => {
    const { service, payments } = setup({
      target: { checkoutExpiresAt: FUTURE, nextReconciliationAt: FUTURE },
    });
    await expect(
      service.reconcile('org-1', REFERENCE, { force: true }),
    ).resolves.toMatchObject({ outcome: 'resolved' });
    expect(payments.inquire).toHaveBeenCalledTimes(1);
  });

  it('never expires a purchase whose window is still open, even when forced', async () => {
    const { service, callbacks } = setup({
      target: { checkoutExpiresAt: FUTURE },
      inquiry: { outcome: 'not_found', code: 'not_found' },
    });
    await expect(
      service.reconcile('org-1', REFERENCE, { force: true }),
    ).resolves.toMatchObject({ outcome: 'deferred' });
    expect(callbacks.ingest).not.toHaveBeenCalled();
  });

  it('asks about a flagged failed purchase a delayed success could promote', async () => {
    const { service, callbacks } = setup({
      target: {
        status: 'failed',
        reconciliationRequired: true,
        reconciliationCode: 'provider_rejected',
      },
    });
    await expect(
      service.reconcile('org-1', REFERENCE, { force: true }),
    ).resolves.toMatchObject({ outcome: 'resolved' });
    expect(callbacks.ingest).toHaveBeenCalledWith(providerEvent);
  });

  it('keeps the original anomaly on a flagged purchase the provider cannot answer for', async () => {
    const { service, purchases, callbacks } = setup({
      target: {
        status: 'failed',
        reconciliationRequired: true,
        reconciliationCode: 'provider_rejected',
      },
      inquiry: { outcome: 'not_found', code: 'not_found' },
    });
    await expect(
      service.reconcile('org-1', REFERENCE, { force: true }),
    ).resolves.toMatchObject({ outcome: 'deferred' });
    expect(callbacks.ingest).not.toHaveBeenCalled();
    const [, , , expected, changes] = purchases.updatePurchase.mock
      .calls[0] as [unknown, string, string, string, Record<string, unknown>];
    expect(expected).toBe('failed');
    expect(changes).toMatchObject({ reconciliationCode: 'provider_rejected' });
  });

  it.each([
    ['successful', true],
    ['refunded', true],
    ['failed', false],
  ])(
    'refuses a %s purchase (flagged: %s) that inquiry cannot change',
    async (status, reconciliationRequired) => {
      const { service, payments } = setup({
        target: { status, reconciliationRequired },
      });
      await expect(
        service.reconcile('org-1', REFERENCE, { force: true }),
      ).resolves.toMatchObject({ outcome: 'not_eligible' });
      expect(payments.inquire).not.toHaveBeenCalled();
    },
  );
});

describe('PaymentReconciliationService.reconcile scheduled', () => {
  const REPORT_ONLY = { scheduled: true, reportOnly: true };

  it('returns a found fact in report-only mode without ingesting it', async () => {
    const { service, callbacks, purchases } = setup();
    await expect(
      service.reconcile('org-1', REFERENCE, REPORT_ONLY),
    ).resolves.toEqual({ outcome: 'resolved', providerEvent });
    expect(callbacks.ingest).not.toHaveBeenCalled();
    expect(purchases.updatePurchase).not.toHaveBeenCalled();
  });

  it('ingests a found fact canonically in active mode and returns it', async () => {
    const { service, callbacks } = setup();
    await expect(
      service.reconcile('org-1', REFERENCE, { scheduled: true }),
    ).resolves.toMatchObject({
      outcome: 'resolved',
      providerEvent,
      ingest: { outcome: 'granted' },
    });
    expect(callbacks.ingest).toHaveBeenCalledWith(providerEvent);
  });

  it('confirms an expiry in report-only mode without expiring anything', async () => {
    const { service, callbacks } = setup({
      inquiry: { outcome: 'not_found', code: 'not_found' },
    });
    await expect(
      service.reconcile('org-1', REFERENCE, REPORT_ONLY),
    ).resolves.toEqual({
      outcome: 'resolved',
      providerCode: 'expiry_confirmed',
    });
    expect(callbacks.ingest).not.toHaveBeenCalled();
  });

  it.each([
    [
      'cannot say',
      { inquiry: { outcome: 'unknown', code: 'provider_unavailable' } },
      'provider_unavailable',
    ],
    ['throws', { inquireError: new Error('socket timeout') }, 'inquiry_failed'],
  ] as const)(
    'defers without writing the purchase when the provider %s in report-only mode',
    async (_label, overrides, providerCode) => {
      const { service, purchases } = setup(
        overrides as Parameters<typeof setup>[0],
      );
      await expect(
        service.reconcile('org-1', REFERENCE, REPORT_ONLY),
      ).resolves.toEqual({ outcome: 'deferred', providerCode });
      expect(purchases.updatePurchase).not.toHaveBeenCalled();
    },
  );

  it('looks at a settled purchase but never flags it for an unanswered inquiry', async () => {
    const { service, payments, purchases } = setup({
      target: { status: 'successful' },
      inquiry: { outcome: 'unknown', code: 'provider_unavailable' },
    });
    await expect(
      service.reconcile('org-1', REFERENCE, { scheduled: true }),
    ).resolves.toEqual({
      outcome: 'deferred',
      providerCode: 'provider_unavailable',
    });
    expect(payments.inquire).toHaveBeenCalledTimes(1);
    expect(purchases.updatePurchase).not.toHaveBeenCalled();
  });

  it('ignores the merchant backoff but not an ineligible status', async () => {
    const due = setup({ target: { nextReconciliationAt: FUTURE } });
    await due.service.reconcile('org-1', REFERENCE, REPORT_ONLY);
    expect(due.payments.inquire).toHaveBeenCalledTimes(1);

    const failed = setup({ target: { status: 'failed' } });
    await expect(
      failed.service.reconcile('org-1', REFERENCE, REPORT_ONLY),
    ).resolves.toEqual({ outcome: 'not_eligible' });
    expect(failed.payments.inquire).not.toHaveBeenCalled();
  });
});
