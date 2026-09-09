import { standaloneCreditBillingConfigService } from '../../../test/contracts/standalone-credit-billing-config';
import { CreditInvariantError } from '../../infrastructure/database/repositories/credit-accounting.repository';
import type {
  DisputeStatus,
  NormalizedProviderEvent,
  PurchaseStatus,
} from '../../shared/ports/payments.port';
import { PaymentCallbackService } from './payment-callback.service';

interface PurchaseRow {
  id: string;
  orgId: string;
  reference: string;
  provider: string;
  mode: string;
  status: PurchaseStatus;
  disputeStatus: DisputeStatus;
  quantity: number;
  unitPriceMinor: number;
  totalMinor: number;
  currency: string;
  refundedMinor: number;
  providerIntentionId: string | null;
  providerOrderId: string | null;
  providerTransactionId: string | null;
}

const config = standaloneCreditBillingConfigService({
  STANDALONE_CREDIT_BILLING_ENABLED: 'true',
  PAYMOB_MODE: 'test',
  PAYMOB_BASE_URL: 'http://localhost:9000',
  PAYMOB_CALLBACK_URL: 'http://localhost:9000/api/webhooks/payments/paymob',
  PAYMOB_RETURN_URL: 'http://localhost:9000',
  PAYMOB_SECRET_KEY: 'sandbox-secret',
  PAYMOB_PUBLIC_KEY: 'sandbox-public',
  PAYMOB_HMAC_SECRET: 'sandbox-hmac',
  PAYMOB_CARD_INTEGRATION_ID: 'card1',
  PAYMOB_WALLET_INTEGRATION_ID: 'wallet1',
  PAYMOB_CHECKOUT_EXPIRATION_SECONDS: '900',
});

const purchase: PurchaseRow = {
  id: 'purchase-1',
  orgId: 'org-1',
  reference: 'akd_1111111111111111111111111111aaaa',
  provider: 'paymob',
  mode: 'test',
  status: 'pending',
  disputeStatus: 'none',
  quantity: 100,
  unitPriceMinor: 200,
  totalMinor: 20000,
  currency: 'EGP',
  refundedMinor: 0,
  providerIntentionId: null,
  providerOrderId: null,
  providerTransactionId: null,
};

function event(
  overrides: Partial<NormalizedProviderEvent> = {},
): NormalizedProviderEvent {
  return {
    provider: 'paymob',
    source: 'callback',
    reference: purchase.reference,
    signal: 'success',
    payment: {
      reference: purchase.reference,
      providerOrderId: 'ord_1',
      providerTransactionId: 'txn_1',
    },
    amountMinor: 20000,
    currency: 'EGP',
    integrationId: 'card1',
    mode: 'test',
    fingerprint: 'a'.repeat(64),
    payloadHash: 'b'.repeat(64),
    ...overrides,
  };
}

type UpdateCall = [unknown, string, string, string, Record<string, unknown>];

function setup(
  overrides: {
    purchase?: Partial<PurchaseRow> | null;
    recordEvent?: jest.Mock;
    reversals?: Record<string, number>;
  } = {},
) {
  const account = {
    orgId: 'org-1',
    status: 'active' as const,
    postedBalance: 30,
    heldCredits: 0,
    version: 2,
  };
  const credits = {
    lockAccount: jest.fn().mockResolvedValue(account),
    insertLedgerEntry: jest.fn().mockResolvedValue({ id: 'ledger-1' }),
    updateProjection: jest.fn().mockResolvedValue(account),
    checkInvariant: jest.fn().mockResolvedValue({ consistent: true }),
    readPurchaseReversals: jest.fn().mockResolvedValue(
      overrides.reversals ?? {
        refundReversedCredits: 0,
        chargebackReversedCredits: 0,
        chargebackReinstatedCredits: 0,
      },
    ),
    findPurchaseLedgerEntry: jest
      .fn()
      .mockResolvedValue({ id: 'ledger-purchase', quantity: 100 }),
  };
  const purchases = {
    lockByReference: jest
      .fn()
      .mockResolvedValue(
        overrides.purchase === null
          ? undefined
          : { ...purchase, ...overrides.purchase },
      ),
    recordEvent:
      overrides.recordEvent ?? jest.fn().mockResolvedValue({ id: 'event-1' }),
    updatePurchase: jest.fn().mockResolvedValue(purchase),
  };
  const db = { transaction: (work: (tx: unknown) => unknown) => work({}) };
  const service = new PaymentCallbackService(
    db as never,
    config,
    credits as never,
    purchases as never,
  );
  return { service, credits, purchases };
}

describe('PaymentCallbackService.ingest', () => {
  it('grants the purchased credits exactly once on a verified success', async () => {
    const { service, credits } = setup();
    await expect(service.ingest(event())).resolves.toMatchObject({
      outcome: 'granted',
      resultCode: 'granted',
    });
    expect(credits.insertLedgerEntry).toHaveBeenCalledTimes(1);
    const [, entry] = credits.insertLedgerEntry.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
    ];
    expect(entry).toMatchObject({
      type: 'purchase',
      quantity: 100,
      purchaseId: 'purchase-1',
      idempotencyKey: `purchase:${purchase.reference}:v1`,
      postedBalanceBefore: 30,
      postedBalanceAfter: 130,
    });
  });

  it('treats a redelivered event as a no-op without granting again', async () => {
    // The unique (provider, fingerprint) index absorbs the insert.
    const { service, credits, purchases } = setup({
      recordEvent: jest.fn().mockResolvedValue(undefined),
    });
    await expect(service.ingest(event())).resolves.toMatchObject({
      outcome: 'duplicate',
      resultCode: 'duplicate_event',
    });
    expect(credits.insertLedgerEntry).not.toHaveBeenCalled();
    expect(purchases.updatePurchase).not.toHaveBeenCalled();
  });

  it('quarantines an event whose reference matches nothing, and grants nothing', async () => {
    const { service, credits, purchases } = setup({ purchase: null });
    await expect(service.ingest(event())).resolves.toMatchObject({
      outcome: 'quarantined',
      resultCode: 'unmatched_reference',
    });
    const [, row] = purchases.recordEvent.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
    ];
    // Null on both, which `payment_event_tenant_check` allows: the event
    // genuinely belongs to no tenant.
    expect(row).toMatchObject({
      orgId: null,
      purchaseId: null,
      verified: true,
    });
    expect(credits.insertLedgerEntry).not.toHaveBeenCalled();
  });

  it.each([
    ['amount', { amountMinor: 19999 }, 'amount_mismatch'],
    ['currency', { currency: 'USD' }, 'currency_mismatch'],
    ['integration', { integrationId: 'someone-else' }, 'integration_mismatch'],
    ['mode', { mode: 'live' as const }, 'mode_mismatch'],
    ['provider', { provider: 'other' }, 'ownership_mismatch'],
  ])(
    'quarantines a %s mismatch and grants nothing',
    async (_l, patch, code) => {
      const { service, credits, purchases } = setup();
      await expect(service.ingest(event(patch))).resolves.toMatchObject({
        outcome: 'quarantined',
        resultCode: 'trusted_data_mismatch',
        errorCode: code,
      });
      expect(credits.insertLedgerEntry).not.toHaveBeenCalled();
      const [, , , , changes] = purchases.updatePurchase.mock.calls[0] as [
        unknown,
        string,
        string,
        string,
        Record<string, unknown>,
      ];
      expect(changes).toMatchObject({
        reconciliationRequired: true,
        reconciliationCode: 'callback_mismatch',
      });
    },
  );

  it('quarantines an event naming a provider transaction the purchase is not bound to', async () => {
    const { service } = setup({ purchase: { providerTransactionId: 'txn_9' } });
    await expect(service.ingest(event())).resolves.toMatchObject({
      errorCode: 'ownership_mismatch',
    });
  });

  it('binds provider identifiers the purchase does not have yet', async () => {
    const { service, purchases } = setup();
    await service.ingest(event());
    const [, , , , changes] = purchases.updatePurchase.mock.calls[0] as [
      unknown,
      string,
      string,
      string,
      Record<string, unknown>,
    ];
    expect(changes).toMatchObject({
      providerOrderId: 'ord_1',
      providerTransactionId: 'txn_1',
    });
  });

  it('does not rebind an identifier that is already set', async () => {
    const { service, purchases } = setup({
      purchase: { providerOrderId: 'ord_1', providerTransactionId: 'txn_1' },
    });
    await service.ingest(event());
    const bindCalls = (
      purchases.updatePurchase.mock.calls as UpdateCall[]
    ).filter((call) =>
      Object.keys(call[4]).some((key) => key.startsWith('provider')),
    );
    expect(bindCalls).toHaveLength(0);
  });

  it('applies a decline without touching the ledger', async () => {
    const { service, credits } = setup();
    await expect(
      service.ingest(event({ signal: 'decline' })),
    ).resolves.toMatchObject({ outcome: 'transitioned' });
    expect(credits.insertLedgerEntry).not.toHaveBeenCalled();
  });

  it('records a late decline after a success as no change', async () => {
    const { service, credits, purchases } = setup({
      purchase: { status: 'successful' },
    });
    await expect(
      service.ingest(event({ signal: 'decline' })),
    ).resolves.toMatchObject({ outcome: 'no_change', resultCode: 'no_change' });
    expect(credits.insertLedgerEntry).not.toHaveBeenCalled();
    const statusChanges = (
      purchases.updatePurchase.mock.calls as UpdateCall[]
    ).filter((call) => call[4].status !== undefined);
    expect(statusChanges).toHaveLength(0);
  });

  it('reverses a full refund against the purchase ledger entry', async () => {
    const { service, credits } = setup({ purchase: { status: 'successful' } });
    await service.ingest(
      event({
        signal: 'refund',
        refundedMinorTotal: 20000,
        sourceReference: 'refund-1',
      }),
    );
    const [, entry] = credits.insertLedgerEntry.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
    ];
    expect(entry).toMatchObject({
      type: 'refund_reversal',
      quantity: -100,
      sourceLedgerEntryId: 'ledger-purchase',
      sourceReference: 'refund-1',
      postedBalanceAfter: -70,
    });
  });

  it('reinstates exactly the quantity the chargeback reversal took', async () => {
    // Not the policy's arithmetic: the database requires the reinstatement to
    // be exactly opposite the reversal row carrying the same reference.
    const { service, credits } = setup({
      purchase: { status: 'successful', disputeStatus: 'lost' },
      reversals: {
        refundReversedCredits: 0,
        chargebackReversedCredits: 100,
        chargebackReinstatedCredits: 0,
      },
    });
    credits.findPurchaseLedgerEntry.mockResolvedValue({
      id: 'ledger-chargeback',
      quantity: -90,
    });
    await service.ingest(
      event({ signal: 'chargeback_won', sourceReference: 'dispute-1' }),
    );
    expect(credits.findPurchaseLedgerEntry).toHaveBeenCalledWith(
      expect.anything(),
      'org-1',
      'purchase-1',
      'chargeback_reversal',
      'dispute-1',
    );
    const [, entry] = credits.insertLedgerEntry.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
    ];
    expect(entry).toMatchObject({
      type: 'chargeback_reinstatement',
      quantity: 90,
      sourceLedgerEntryId: 'ledger-chargeback',
    });
  });

  it('refuses to reverse when there is no source entry to point at', async () => {
    const { service, credits } = setup({ purchase: { status: 'successful' } });
    credits.findPurchaseLedgerEntry.mockResolvedValue(undefined);
    await expect(
      service.ingest(
        event({
          signal: 'refund',
          refundedMinorTotal: 20000,
          sourceReference: 'refund-1',
        }),
      ),
    ).rejects.toThrow(/no purchase entry to point at/);
  });

  it('rethrows a transient database failure so the provider retries', async () => {
    const { service, credits } = setup();
    credits.updateProjection.mockRejectedValue(new Error('connection lost'));
    await expect(service.ingest(event())).rejects.toThrow('connection lost');
  });

  it('freezes rather than loops when the projection no longer matches the ledger', async () => {
    // Retrying forever against a broken account only buries the alert.
    const { service, credits } = setup();
    credits.lockAccount.mockRejectedValue(
      new CreditInvariantError({
        orgId: 'org-1',
        postedBalance: 30,
        heldCredits: 0,
        ledgerBalance: '20',
        reservationHolds: '0',
        consistent: false,
      }),
    );
    await expect(service.ingest(event())).resolves.toMatchObject({
      outcome: 'frozen',
      resultCode: 'credit_invariant_frozen',
    });
  });

  it('refuses to leave a projection that stopped matching the ledger', async () => {
    const { service, credits } = setup();
    credits.checkInvariant.mockResolvedValue({ consistent: false });
    await expect(service.ingest(event())).resolves.toMatchObject({
      outcome: 'frozen',
    });
  });

  it('promotes a delayed success and grants once', async () => {
    const { service, credits } = setup({ purchase: { status: 'expired' } });
    await expect(service.ingest(event())).resolves.toMatchObject({
      outcome: 'granted',
    });
    expect(credits.insertLedgerEntry).toHaveBeenCalledTimes(1);
  });

  it('never expires a purchase from a callback, only from an inquiry', async () => {
    const { service, purchases } = setup();
    await expect(
      service.ingest(event({ signal: 'expiry_confirmed' })),
    ).resolves.toMatchObject({ outcome: 'no_change' });
    const statusChanges = (
      purchases.updatePurchase.mock.calls as UpdateCall[]
    ).filter((call) => call[4].status !== undefined);
    expect(statusChanges).toHaveLength(0);
  });

  it('expires a stale purchase when an inquiry confirms it', async () => {
    const { service, purchases } = setup();
    await expect(
      service.ingest(event({ signal: 'expiry_confirmed', source: 'inquiry' })),
    ).resolves.toMatchObject({ outcome: 'transitioned' });
    const [, , , , changes] = purchases.updatePurchase.mock.calls.at(-1) as [
      unknown,
      string,
      string,
      string,
      Record<string, unknown>,
    ];
    expect(changes).toMatchObject({ status: 'expired' });
  });
});
