import { usageAccountingFixture } from '../../../../test/contracts/usage-accounting-fixture';
import type { Server } from 'node:http';
import { Test } from '@nestjs/testing';
import { type ExecutionContext, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import type {
  WooCommerceConnection,
  WooCommerceConnectionsRepository,
} from '../../database/repositories/woocommerce-connections.repository';
import type { integrations } from '../../database/schema';
import {
  DualAuthGuard,
  type AuthenticatedUser,
} from '../../../modules/auth/guards/dual-auth.guard';
import { BillingService } from '../../../modules/onboarding/billing.service';
import type { OnboardingStateDto } from '../../../modules/onboarding/dto/onboarding.dto';
import { OnboardingController } from '../../../modules/onboarding/onboarding.controller';
import { OnboardingService } from '../../../modules/onboarding/onboarding.service';
import { OnboardingStateService } from '../../../modules/onboarding/onboarding-state.service';
import { SettingsController } from '../../../modules/onboarding/settings.controller';
import { SourceSetupService } from '../../../modules/onboarding/source-setup.service';
import { BillingEntitlementService } from '../../../modules/verification-core/billing-entitlement.service';
import type {
  SourceHealthDto,
  SourceWebhookHealth,
} from '../../../shared/commerce/source-setup';
import type { WooCommerceConnectionHealthService } from './woocommerce-connection-health.service';
import { WooCommerceSetupContributor } from './woocommerce-setup.contributor';

type Source = typeof integrations.$inferSelect;

const NOW = '2026-10-05T10:00:00.000Z';
const STORE = 'https://shop.example.com/eg';

function connection(
  overrides: Partial<WooCommerceConnection> = {},
): WooCommerceConnection {
  return {
    integrationId: 'int-1',
    orgId: 'org-1',
    storeUrl: STORE,
    storeVerifiedAt: NOW,
    consumerKeyEncrypted: 'v1:key',
    consumerSecretEncrypted: 'v1:secret',
    webhookSecretEncrypted: 'v1:webhook',
    webhookTokenHash: 'h'.repeat(64),
    orderCreatedWebhookId: 101,
    orderUpdatedWebhookId: 102,
    orderCreatedWebhookState: 'active',
    orderUpdatedWebhookState: 'active',
    webhooksCheckedAt: NOW,
    wooVersion: '9.8.1',
    health: 'ok',
    rejectedDeliveries: 0,
    lastRejectedAt: null,
    connectedBy: 'user-1',
    connectedAt: NOW,
    disconnectedAt: null,
    disconnectedBy: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/**
 * The WooCommerce contributor behind the real onboarding and settings routes
 * (US-07-05): setup can be finished with no currency and no phone country,
 * and health carries each webhook's state. Only the edges are fakes.
 */
describe('WooCommerce setup through the onboarding routes', () => {
  let app: INestApplication<Server>;
  let source: Source;
  let row: WooCommerceConnection;
  let webhooks: SourceWebhookHealth | null;
  let user: AuthenticatedUser;
  const repository = {
    findActiveByOrg: jest.fn(),
    findByOrg: jest.fn(),
    findByOrgAndPlatformDomain: jest.fn(),
    updateById: jest.fn(),
  };
  const usage = {
    getEntitlementSource: jest.fn(),
    getIntegrationUsageForPeriod: jest.fn(),
    resetCountersForPeriod: jest.fn(),
  };
  const inspectWebhooks = jest.fn(() => Promise.resolve(webhooks));

  const http = () => request(app.getHttpServer());
  const stateOf = async (): Promise<OnboardingStateDto> =>
    (
      (await http().get('/api/onboarding/state').expect(200)).body as {
        state: OnboardingStateDto;
      }
    ).state;

  beforeEach(async () => {
    jest.clearAllMocks();
    row = connection();
    webhooks = {
      checkedAt: NOW,
      items: [
        { kind: 'order_created', state: 'active' },
        { kind: 'order_updated', state: 'active' },
      ],
    };
    source = {
      id: 'int-1',
      orgId: 'org-1',
      platformType: 'woocommerce',
      platformStoreUrl: 'woocommerce:org-1',
      isActive: true,
      storeName: 'Noor Store',
      defaultLanguage: 'auto',
      isAutoVerifyEnabled: true,
      assumeCodWhenPaymentMissing: false,
      onboardingStatus: 'pending',
      billingPlanId: 'starter',
      billingStatus: 'not_required',
      billingActivatedAt: '2026-05-01T00:00:00Z',
      shopifySubscriptionId: null,
      followUpEnabled: true,
      followUpDelayMinutes: 120,
      escalationEnabled: true,
      escalationDelayMinutes: 360,
      quietHoursEnabled: false,
      quietHoursStart: null,
      quietHoursEnd: null,
      timezone: 'Africa/Cairo',
      sendDelayMinutes: 0,
    } as Source;
    user = {
      userId: 'user-1',
      orgId: 'org-1',
      role: 'owner',
      source: 'supabase',
    };
    repository.findActiveByOrg.mockImplementation(() =>
      Promise.resolve(source.isActive ? [source] : []),
    );
    repository.findByOrg.mockImplementation(() => Promise.resolve([source]));
    repository.findByOrgAndPlatformDomain.mockImplementation(() =>
      Promise.resolve(source),
    );
    repository.updateById.mockImplementation(
      (_id: string, changes: Partial<Source>) => {
        source = { ...source, ...changes };
        return Promise.resolve(source);
      },
    );
    usage.getEntitlementSource.mockImplementation(() =>
      Promise.resolve(source),
    );
    usage.getIntegrationUsageForPeriod.mockResolvedValue({
      consumedCount: 0,
      includedLimit: 30,
    });

    const sourceSetup = new SourceSetupService(
      [
        new WooCommerceSetupContributor(
          {
            findByIntegration: (integrationId: string, orgId: string) =>
              Promise.resolve(
                integrationId === row.integrationId && orgId === row.orgId
                  ? row
                  : undefined,
              ),
          } as unknown as WooCommerceConnectionsRepository,
          { inspectWebhooks } as unknown as WooCommerceConnectionHealthService,
        ),
      ],
      repository as never,
      {
        summarizeForIntegration: () =>
          Promise.resolve({
            lastAcceptedAt: null,
            acceptedCount: 0,
            failedCount: 0,
            lastFailedAt: null,
            waitingCount: 0,
            oldestWaitingAt: null,
          }),
      } as never,
      {
        summarizeForIntegration: () =>
          Promise.resolve({
            failedCount: 0,
            lastFailedAt: null,
            requiresAssistance: false,
            pendingCount: 0,
          }),
      } as never,
      { supports: () => false } as never,
      {
        sendVerificationTemplate: jest.fn(),
        getSenderStatus: () => ({
          sender: 'akeed_shared' as const,
          status: 'configured' as const,
        }),
      },
    );
    const state = new OnboardingStateService(
      repository as never,
      { getShopName: jest.fn() },
      undefined,
      undefined,
      { findById: () => Promise.resolve({ name: 'Noor Company' }) } as never,
      sourceSetup,
    );
    const service = new OnboardingService(
      state,
      new BillingService(
        repository as never,
        { hasClaim: jest.fn(), createIfNew: jest.fn() } as never,
        usage as never,
        { getShopName: jest.fn() } as never,
        {
          resolveAllPlans: jest.fn(),
          resolvePlan: jest.fn(),
          isBillingRequired: jest.fn().mockReturnValue(false),
        } as never,
      ),
      new BillingEntitlementService(
        usage as never,
        usageAccountingFixture({ enabled: true }),
      ),
      { readStatus: () => Promise.resolve(null) } as never,
      undefined,
      undefined,
      undefined,
      sourceSetup,
    );
    const module = await Test.createTestingModule({
      controllers: [OnboardingController, SettingsController],
      providers: [{ provide: OnboardingService, useValue: service }],
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
    await app?.close();
  });

  it('identifies the store, automation and the Akeed sender, with no currency or phone country to enter', async () => {
    const state = await stateOf();

    expect(state.sourceSetup).toEqual({
      connectionState: 'connected',
      disconnectedAt: null,
      store: { reference: STORE, verified: true },
      orderDefaults: { currency: null, phoneCountry: null },
      sender: { sender: 'akeed_shared', status: 'configured' },
      canComplete: true,
      blockedReasons: [],
    });
    expect(state).toMatchObject({
      source: { platformType: 'woocommerce' },
      isAutoVerifyEnabled: true,
      followUpEnabled: true,
      escalationEnabled: true,
      standaloneSetup: null,
    });
    // Reading the state never asks the store.
    expect(inspectWebhooks).not.toHaveBeenCalled();
  });

  it('finishes onboarding through the common route without either', async () => {
    await http().post('/api/onboarding/complete').expect(201);

    expect(repository.updateById).toHaveBeenCalledWith(
      'int-1',
      expect.objectContaining({ onboardingStatus: 'completed' }),
    );
  });

  it.each([
    [{ health: 'credentials_rejected' }, ['credentials_rejected']],
    [{ health: 'permission_denied' }, ['credentials_rejected']],
    [{ orderUpdatedWebhookState: 'disabled' }, ['webhook_disabled']],
  ])('blocks completion for %j', async (state, blockedReasons) => {
    row = connection(state);

    await http()
      .post('/api/onboarding/complete')
      .expect(409)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          code: 'ONBOARDING_BLOCKED',
          blockedReasons,
        });
      });
    expect(repository.updateById).not.toHaveBeenCalled();
  });

  it('adds each webhook’s state to health, for any member, with no overall verdict', async () => {
    user = { ...user, role: 'viewer' };
    webhooks = {
      checkedAt: NOW,
      items: [
        { kind: 'order_created', state: 'active' },
        { kind: 'order_updated', state: 'disabled' },
      ],
    };

    const health = (await http().get('/api/settings/source-health').expect(200))
      .body as SourceHealthDto;

    expect(health).toMatchObject({
      platformType: 'woocommerce',
      connectionState: 'connected',
      credentials: { status: 'ok' },
      events: { lastAcceptedAt: null, acceptedCount: 0 },
      delivery: { secretsMissing: false, rejectedCount: 0 },
      webhooks,
    });
    expect(health).not.toHaveProperty('status');
    expect(inspectWebhooks).toHaveBeenCalledWith('int-1', 'org-1');
    expect(JSON.stringify(health)).not.toMatch(/v1:|h{64}/);
  });

  it('keeps state and health readable after a disconnect, and refuses completion', async () => {
    source = { ...source, isActive: false, onboardingStatus: 'completed' };
    row = connection({
      storeVerifiedAt: null,
      consumerKeyEncrypted: null,
      consumerSecretEncrypted: null,
      webhookSecretEncrypted: null,
      webhookTokenHash: null,
      orderCreatedWebhookId: null,
      orderUpdatedWebhookId: null,
      orderCreatedWebhookState: null,
      orderUpdatedWebhookState: null,
      disconnectedAt: NOW,
      disconnectedBy: 'user-1',
    });
    webhooks = null;

    expect((await stateOf()).sourceSetup).toMatchObject({
      connectionState: 'disconnected',
      disconnectedAt: NOW,
      canComplete: false,
      blockedReasons: ['source_disconnected'],
    });
    const health = (await http().get('/api/settings/source-health').expect(200))
      .body as SourceHealthDto;
    expect(health).toMatchObject({
      connectionState: 'disconnected',
      credentials: { status: 'removed' },
    });
    expect(health).not.toHaveProperty('webhooks');
    await http()
      .post('/api/onboarding/complete')
      .expect(404)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'ONBOARDING_SOURCE_INACTIVE' });
      });
  });
});
