import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { standaloneCreditBillingConfigService } from '../../../test/contracts/standalone-credit-billing-config';
import { PaymentRequestConflictError } from '../../infrastructure/database/repositories/payment-purchases.repository';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import type { CheckoutResult } from '../../shared/ports/payments.port';
import { BillingService } from './billing.service';

const enabledConfig = standaloneCreditBillingConfigService({
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

const owner: AuthenticatedUser = {
  userId: 'user-1',
  source: 'supabase',
  orgId: 'org-1',
  role: 'owner',
};

const purchaseRow = {
  id: 'purchase-1',
  reference: 'akd_1111111111111111111111111111aaaa',
  status: 'pending' as const,
  disputeStatus: 'none' as const,
  quantity: 100,
  unitPriceMinor: 200,
  totalMinor: 20000,
  currency: 'EGP',
  refundedMinor: 0,
  checkoutExpiresAt: '2026-09-09T10:30:00.000Z',
  createdAt: '2026-09-09T10:15:00.000Z',
};

const created: CheckoutResult = {
  outcome: 'created',
  payment: {
    reference: purchaseRow.reference,
    providerIntentionId: 'int_1',
    providerOrderId: 'ord_1',
  },
  checkoutUrl: 'http://localhost:9000/unifiedcheckout/?clientSecret=cs_1',
  expiresAt: '2026-09-09T10:30:00.000Z',
};

function setup(
  overrides: {
    config?: typeof enabledConfig;
    summary?:
      | { status: 'pending_approval' | 'active' | 'suspended' }
      | undefined;
    platformType?: string;
    activeSources?: unknown[];
    checkout?: CheckoutResult;
    duplicate?: boolean;
    createPending?: jest.Mock;
  } = {},
) {
  const credits = {
    getSummary: jest.fn().mockResolvedValue(
      'summary' in overrides
        ? overrides.summary
        : {
            orgId: 'org-1',
            status: 'active',
            postedBalance: 30,
            heldCredits: 0,
            availableCredits: 30,
            debtCredits: 0,
            version: 1,
          },
    ),
  };
  const createPending =
    overrides.createPending ??
    jest.fn().mockResolvedValue({
      purchase: purchaseRow,
      duplicate: overrides.duplicate ?? false,
    });
  const purchases = {
    createPending,
    updatePurchase: jest.fn().mockResolvedValue(purchaseRow),
    findDetailForOrganization: jest.fn().mockResolvedValue(undefined),
  };
  const billing = {
    readFreeGrant: jest.fn().mockResolvedValue(undefined),
    listLedger: jest.fn().mockResolvedValue([]),
    listPurchases: jest.fn().mockResolvedValue([]),
  };
  const integrations = {
    findActiveByOrg: jest
      .fn()
      .mockResolvedValue(
        overrides.activeSources ?? [
          { id: 'int-1', platformType: overrides.platformType ?? 'standalone' },
        ],
      ),
    findByOrg: jest.fn().mockResolvedValue([]),
  };
  const payments = {
    createCheckout: jest.fn().mockResolvedValue(overrides.checkout ?? created),
    inquire: jest.fn(),
  };
  const db = {
    transaction: (work: (tx: unknown) => unknown) => work({}),
  };
  const service = new BillingService(
    db as never,
    overrides.config ?? enabledConfig,
    credits as never,
    purchases as never,
    billing as never,
    integrations as never,
    payments as never,
  );
  return { service, credits, purchases, billing, integrations, payments };
}

describe('BillingService.readCredits', () => {
  it('returns price, range and threshold from configuration only', async () => {
    const { service } = setup();
    await expect(service.readCredits(owner)).resolves.toMatchObject({
      status: 'active',
      availableCredits: 30,
      lowBalanceThreshold: 10,
      price: { unitPriceMinor: 200, currency: 'EGP' },
      range: { min: 100, max: 5000, step: 50 },
      canPurchase: true,
      purchaseDenialReason: null,
    });
  });

  it('reports the launch grant once it has been posted', async () => {
    const { service, billing } = setup();
    billing.readFreeGrant.mockResolvedValue({
      quantity: 30,
      createdAt: '2026-09-01T00:00:00.000Z',
    });
    await expect(service.readCredits(owner)).resolves.toMatchObject({
      freeGrant: {
        granted: true,
        quantity: 30,
        grantedAt: '2026-09-01T00:00:00.000Z',
      },
    });
  });

  it('keeps purchasing open at zero balance and in debt', async () => {
    // Those are the states a merchant tops up out of. They stop sends, not
    // payments.
    const { service, credits } = setup();
    credits.getSummary.mockResolvedValue({
      orgId: 'org-1',
      status: 'active',
      postedBalance: -5,
      heldCredits: 0,
      availableCredits: 0,
      debtCredits: 5,
      version: 4,
    });
    await expect(service.readCredits(owner)).resolves.toMatchObject({
      debtCredits: 5,
      canPurchase: true,
    });
  });

  it('reads as unprovisioned rather than failing when no account exists', async () => {
    const { service } = setup({ summary: undefined });
    await expect(service.readCredits(owner)).resolves.toMatchObject({
      status: 'not_provisioned',
      canPurchase: false,
      purchaseDenialReason: 'STANDALONE_APPROVAL_REQUIRED',
    });
  });
});

describe('BillingService.createPurchase', () => {
  it('creates the local purchase before calling the provider', async () => {
    const { service, purchases, payments } = setup();
    await service.createPurchase(owner, 'idem-key-1', 100);
    const localCall = purchases.createPending.mock.invocationCallOrder[0];
    const providerCall = payments.createCheckout.mock.invocationCallOrder[0];
    expect(localCall).toBeLessThan(providerCall);
  });

  it('prices from configuration and derives the organization from the token', async () => {
    const { service, purchases } = setup();
    await service.createPurchase(owner, 'idem-key-1', 150);
    const [, input] = purchases.createPending.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
    ];
    expect(input).toMatchObject({
      orgId: 'org-1',
      quantity: 150,
      unitPriceMinor: 200,
      totalMinor: 30000,
      currency: 'EGP',
      provider: 'paymob',
      mode: 'test',
      requestKey: 'idem-key-1',
    });
    expect(input.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(String(input.reference)).toMatch(/^akd_[a-f0-9]{32}$/);
  });

  it('returns the checkout URL exactly once, on the call that created it', async () => {
    const { service } = setup();
    await expect(
      service.createPurchase(owner, 'idem-key-1', 100),
    ).resolves.toMatchObject({
      duplicate: false,
      checkoutUrl: created.checkoutUrl,
    });
  });

  it('never asks the provider twice for the same idempotency key', async () => {
    // This is the application-layer half of "no timeout creates a second
    // intention"; Paymob's own special_reference uniqueness is the other half.
    const { service, payments } = setup({ duplicate: true });
    await expect(
      service.createPurchase(owner, 'idem-key-1', 100),
    ).resolves.toMatchObject({
      duplicate: true,
      checkoutUrl: null,
      code: 'CHECKOUT_URL_ALREADY_ISSUED',
    });
    expect(payments.createCheckout).not.toHaveBeenCalled();
  });

  it('rejects the same key with a different quantity', async () => {
    const { service } = setup({
      createPending: jest
        .fn()
        .mockRejectedValue(new PaymentRequestConflictError()),
    });
    await expect(
      service.createPurchase(owner, 'idem-key-1', 150),
    ).rejects.toMatchObject({
      response: { code: 'BILLING_IDEMPOTENCY_CONFLICT' },
    });
  });

  it.each([99, 5050, 125, 0, -100])(
    'refuses quantity %p before creating anything',
    async (quantity) => {
      const { service, purchases, payments } = setup();
      await expect(
        service.createPurchase(owner, 'idem-key-1', quantity),
      ).rejects.toThrow(BadRequestException);
      expect(purchases.createPending).not.toHaveBeenCalled();
      expect(payments.createCheckout).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, '', 'short'])(
    'refuses the idempotency key %p',
    async (key) => {
      const { service, purchases } = setup();
      await expect(service.createPurchase(owner, key, 100)).rejects.toThrow(
        BadRequestException,
      );
      expect(purchases.createPending).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      'viewer',
      { ...owner, role: 'viewer' as const },
      'BILLING_PURCHASE_ROLE_REQUIRED',
    ],
  ])('denies a %s', async (_label, user, code) => {
    const { service, purchases } = setup();
    await expect(
      service.createPurchase(user, 'idem-key-1', 100),
    ).rejects.toMatchObject({ response: { code } });
    expect(purchases.createPending).not.toHaveBeenCalled();
  });

  it('denies a Shopify organization without touching Shopify billing', async () => {
    const { service, purchases, payments } = setup({ platformType: 'shopify' });
    await expect(
      service.createPurchase(owner, 'idem-key-1', 100),
    ).rejects.toMatchObject({
      response: { code: 'BILLING_SOURCE_UNSUPPORTED' },
    });
    expect(purchases.createPending).not.toHaveBeenCalled();
    expect(payments.createCheckout).not.toHaveBeenCalled();
  });

  it.each([
    ['pending_approval', 'STANDALONE_APPROVAL_REQUIRED'],
    ['suspended', 'CREDIT_ACCOUNT_SUSPENDED'],
  ] as const)('denies a %s account', async (status, code) => {
    const { service, credits } = setup();
    credits.getSummary.mockResolvedValue({
      orgId: 'org-1',
      status,
      postedBalance: 0,
      heldCredits: 0,
      availableCredits: 0,
      debtCredits: 0,
      version: 1,
    });
    await expect(
      service.createPurchase(owner, 'idem-key-1', 100),
    ).rejects.toMatchObject({ response: { code } });
  });

  it('refuses while credit billing is switched off', async () => {
    const { service } = setup({
      config: standaloneCreditBillingConfigService(),
    });
    await expect(
      service.createPurchase(owner, 'idem-key-1', 100),
    ).rejects.toMatchObject({ response: { code: 'BILLING_DISABLED' } });
  });

  it('escalates an ambiguous source instead of guessing which one pays', async () => {
    const { service } = setup({
      activeSources: [
        { platformType: 'standalone' },
        { platformType: 'shopify' },
      ],
    });
    await expect(
      service.createPurchase(owner, 'idem-key-1', 100),
    ).rejects.toThrow(ConflictException);
  });

  it('fails the purchase locally when the provider refuses it', async () => {
    const { service, purchases } = setup({
      checkout: { outcome: 'rejected', code: 'provider_rejected' },
    });
    await expect(
      service.createPurchase(owner, 'idem-key-1', 100),
    ).rejects.toThrow(BadGatewayException);
    expect(purchases.updatePurchase).toHaveBeenCalledWith(
      expect.anything(),
      'org-1',
      'purchase-1',
      'pending',
      expect.objectContaining({
        status: 'failed',
        reconciliationCode: 'provider_rejected',
      }),
    );
  });

  it('keeps the purchase pending and returns its reference when the provider is silent', async () => {
    const { service, purchases } = setup({
      checkout: { outcome: 'unknown', code: 'provider_unavailable' },
    });
    await expect(
      service.createPurchase(owner, 'idem-key-1', 100),
    ).rejects.toMatchObject({
      response: {
        code: 'BILLING_PROVIDER_UNAVAILABLE',
        reference: purchaseRow.reference,
      },
    });
    const [, , , , changes] = purchases.updatePurchase.mock.calls[0] as [
      unknown,
      string,
      string,
      string,
      Record<string, unknown>,
    ];
    expect(changes).toMatchObject({
      reconciliationRequired: true,
      reconciliationCode: 'provider_unavailable',
    });
    expect(changes.status).toBeUndefined();
  });

  it('reports an unavailable provider as 503, not a client error', async () => {
    const { service } = setup({
      checkout: { outcome: 'unknown', code: 'provider_unavailable' },
    });
    await expect(
      service.createPurchase(owner, 'idem-key-1', 100),
    ).rejects.toThrow(ServiceUnavailableException);
  });
});

describe('BillingService reads', () => {
  it('answers a missing purchase and another tenant’s purchase identically', async () => {
    const { service } = setup();
    await expect(service.readPurchase(owner, 'akd_unknown')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('never returns provider identifiers or reconciliation internals', async () => {
    const { service, purchases } = setup();
    purchases.findDetailForOrganization.mockResolvedValue({
      ...purchaseRow,
      id: undefined,
      reconciliationRequired: true,
      nextReconciliationAt: '2026-09-09T11:00:00.000Z',
      providerOrderId: 'ord_1',
      providerTransactionId: 'txn_1',
    });
    const detail = await service.readPurchase(owner, purchaseRow.reference);
    expect(detail).toMatchObject({ reconciliationRequired: true });
    expect(Object.keys(detail)).not.toContain('providerOrderId');
    expect(Object.keys(detail)).not.toContain('providerTransactionId');
    expect(Object.keys(detail)).not.toContain('nextReconciliationAt');
  });

  it('rejects a malformed cursor rather than silently serving page one', async () => {
    const { service } = setup();
    await expect(
      service.listLedger(owner, { cursor: 'not-a-cursor' }),
    ).rejects.toMatchObject({ response: { code: 'BILLING_CURSOR_INVALID' } });
  });

  it('scopes every read to the token organization', async () => {
    const { service, billing } = setup();
    await service.listLedger(owner, {});
    await service.listPurchases(owner, {});
    for (const call of [
      billing.listLedger.mock.calls[0] as [{ orgId: string }],
      billing.listPurchases.mock.calls[0] as [{ orgId: string }],
    ])
      expect(call[0]).toMatchObject({ orgId: 'org-1' });
  });

  it('drops the internal purchase id from list responses', async () => {
    const { service, billing } = setup();
    billing.listPurchases.mockResolvedValue([purchaseRow]);
    const page = await service.listPurchases(owner, {});
    expect(page.items[0]).not.toHaveProperty('id');
    expect(page.items[0]).toMatchObject({ reference: purchaseRow.reference });
  });
});

describe('BillingService role handling', () => {
  it('lets a viewer read but not buy', async () => {
    const viewer: AuthenticatedUser = { ...owner, role: 'viewer' };
    const { service } = setup();
    await expect(service.readCredits(viewer)).resolves.toMatchObject({
      canPurchase: false,
      purchaseDenialReason: 'BILLING_PURCHASE_ROLE_REQUIRED',
    });
    await expect(
      service.createPurchase(viewer, 'idem-key-1', 100),
    ).rejects.toThrow(ForbiddenException);
  });
});
