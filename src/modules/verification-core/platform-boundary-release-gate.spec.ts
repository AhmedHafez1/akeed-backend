import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import { CommerceOutcomeRegistryService } from '../commerce-outcomes/commerce-outcome-registry.service';
import { OrdersRepository } from '../../infrastructure/database/repositories/orders.repository';
import { VerificationsRepository } from '../../infrastructure/database/repositories/verifications.repository';
import { IntegrationMonthlyUsageRepository } from '../../infrastructure/database/repositories/integration-monthly-usage.repository';
import { VerificationAutomationProducer } from '../verification-automation/verification-automation.producer';
import {
  COMMERCE_OUTCOME_ADAPTERS,
  type CommerceOutcomeAdapter,
} from '../../shared/commerce/commerce-outcome';
import { ORDER_ELIGIBILITY_STRATEGIES } from './strategies/order-eligibility.strategy';
import { OrderEligibilityService } from './order-eligibility.service';
import { BillingEntitlementService } from './billing-entitlement.service';
import { CreditApprovalService } from './credit-approval.service';
import { VerificationSendService } from './verification-send.service';
import { VerificationHubService } from './verification-hub.service';

describe('E02 platform-neutral verification core release gate', () => {
  it('keeps production verification-core files free of Shopify service imports', () => {
    const directory = resolve(__dirname);
    const productionFiles = readdirSync(directory).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'),
    );

    for (const file of productionFiles) {
      const source = readFileSync(resolve(directory, file), 'utf8');
      expect(source).not.toMatch(/ShopifyApiService|spokes\/shopify/);
    }
  });

  it('keeps production verification-core files free of platform branching', () => {
    const directory = resolve(__dirname);
    const productionFiles = readdirSync(directory).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'),
    );

    // Once an order is normalized, the core must behave identically for every
    // commerce source. Platform-specific behaviour belongs in a spoke behind
    // one of the registries, never in a branch here.
    for (const file of productionFiles) {
      const source = readFileSync(resolve(directory, file), 'utf8');
      expect(source).not.toMatch(/platformType\s*[=!]==/);
      expect(source).not.toMatch(
        /'(shopify|standalone|salla|zid|woocommerce|easyorders)'/,
      );
    }
  });

  it('processes and synchronizes a standalone order using registry test ports only', async () => {
    const integration = {
      id: 'integration-neutral',
      orgId: 'org-neutral',
      platformType: 'standalone',
      platformStoreUrl: 'standalone:synthetic',
      accessToken: null,
      isActive: true,
      metadata: {},
      billingStatus: 'not_required',
      billingPlanId: 'starter',
      billingActivatedAt: '2026-09-01T00:00:00.000Z',
      isAutoVerifyEnabled: true,
      onboardingStatus: 'completed',
      followUpEnabled: false,
      followUpDelayMinutes: 0,
      escalationEnabled: false,
      escalationDelayMinutes: 0,
      quietHoursEnabled: false,
      quietHoursStart: null,
      quietHoursEnd: null,
      timezone: 'Africa/Cairo',
      sendDelayMinutes: 0,
    };
    const persistedOrder = {
      id: 'order-neutral',
      orgId: integration.orgId,
      integrationId: integration.id,
      externalOrderId: 'external-neutral',
      isTest: false,
      integration,
    };
    const execute = jest.fn().mockResolvedValue({ status: 'applied' });
    const adapter: CommerceOutcomeAdapter = {
      platformType: 'standalone',
      requiresActiveConnection: false,
      capabilities: new Set(['customer_confirmation']),
      execute,
    };
    const ordersRepository = {
      findBySourceExternalId: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockResolvedValue(persistedOrder),
      findById: jest.fn().mockResolvedValue(persistedOrder),
      findForOutcomeDispatch: jest.fn().mockResolvedValue(persistedOrder),
    };
    const verificationsRepository = {
      findByOrderId: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockResolvedValue({ id: 'verification-neutral' }),
      createForOrderIfAbsent: jest.fn().mockResolvedValue({
        verification: { id: 'verification-neutral' },
        created: true,
      }),
      reopenRetryableInitialFailure: jest.fn().mockResolvedValue(false),
      findById: jest.fn().mockResolvedValue({
        id: 'verification-neutral',
        orderId: persistedOrder.id,
        orgId: integration.orgId,
      }),
      updateByIdForOrg: jest.fn(),
    };
    const module = await Test.createTestingModule({
      providers: [
        VerificationHubService,
        CommerceOutcomeRegistryService,
        OrderEligibilityService,
        BillingEntitlementService,
        {
          provide: CreditApprovalService,
          useValue: { resolveDenial: jest.fn().mockResolvedValue(null) },
        },
        { provide: OrdersRepository, useValue: ordersRepository },
        { provide: VerificationsRepository, useValue: verificationsRepository },
        {
          provide: IntegrationMonthlyUsageRepository,
          useValue: {
            getEntitlementSource: jest.fn().mockResolvedValue(integration),
            getIntegrationUsageForPeriod: jest
              .fn()
              .mockResolvedValue({ consumedCount: 0 }),
          },
        },
        {
          provide: VerificationSendService,
          useValue: {
            sendInitial: jest.fn().mockResolvedValue({
              status: 'sent',
              sentAt: '2026-09-03T00:00:00.000Z',
            }),
          },
        },
        {
          provide: VerificationAutomationProducer,
          useValue: {
            enqueueInitialSend: jest.fn(),
            enqueueFollowUp: jest.fn(),
            enqueueNoReplyEscalation: jest.fn(),
          },
        },
        {
          provide: ORDER_ELIGIBILITY_STRATEGIES,
          useValue: [
            {
              platform: 'standalone',
              evaluateOrderForVerification: () => ({
                eligible: true,
                reason: 'cod_match',
              }),
            },
          ],
        },
        { provide: COMMERCE_OUTCOME_ADAPTERS, useValue: [adapter] },
      ],
    }).compile();

    try {
      const hub = module.get(VerificationHubService);
      await expect(
        hub.handleNewOrder(
          {
            orgId: integration.orgId,
            integrationId: integration.id,
            externalOrderId: persistedOrder.externalOrderId,
            customerPhone: '+201000000000',
            totalPrice: '100.00',
            currency: 'EGP',
            codStatus: 'cod',
          },
          integration as never,
        ),
      ).resolves.toEqual({
        orderId: persistedOrder.id,
        verificationId: 'verification-neutral',
      });

      await hub.finalizeVerification('verification-neutral', 'confirmed');

      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: integration.orgId,
          integrationId: integration.id,
          externalOrderId: persistedOrder.externalOrderId,
          action: 'customer_confirmation',
          connection: integration,
        }),
      );
    } finally {
      await module.close();
    }
  });
});
