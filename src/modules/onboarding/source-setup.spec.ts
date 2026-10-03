import { usageAccountingFixture } from '../../../test/contracts/usage-accounting-fixture';
import type { Server } from 'node:http';
import { Test } from '@nestjs/testing';
import { type ExecutionContext, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { OnboardingController } from './onboarding.controller';
import { SettingsController } from './settings.controller';
import { OnboardingService } from './onboarding.service';
import { OnboardingStateService } from './onboarding-state.service';
import { BillingService } from './billing.service';
import { SourceSetupService } from './source-setup.service';
import { BillingEntitlementService } from '../verification-core/billing-entitlement.service';
import {
  DualAuthGuard,
  type AuthenticatedUser,
} from '../auth/guards/dual-auth.guard';
import type { integrations } from '../../infrastructure/database/schema';
import type {
  SourceHealthDto,
  SourceSetupContribution,
  SourceSetupContributor,
} from '../../shared/commerce/source-setup';
import type { CommerceOutcomeAction } from '../../shared/commerce/commerce-outcome';
import type { OnboardingStateDto } from './dto/onboarding.dto';

type Source = typeof integrations.$inferSelect;

const CONNECTED: SourceSetupContribution = {
  connectionState: 'connected',
  disconnectedAt: null,
  store: { reference: 'store-1', verified: true },
  orderDefaults: { currency: 'EGP', phoneCountry: 'EG' },
  blockedReasons: [],
  credentials: { status: 'ok' },
  delivery: { secretsMissing: false, rejectedCount: 0, lastRejectedAt: null },
};
const DISCONNECTED_AT = '2026-10-03T12:00:00.000Z';
const DISCONNECTED: SourceSetupContribution = {
  ...CONNECTED,
  connectionState: 'disconnected',
  disconnectedAt: DISCONNECTED_AT,
  store: { reference: 'store-1', verified: false },
  blockedReasons: ['source_disconnected'],
  credentials: { status: 'removed' },
};
const NO_EVENTS = {
  lastAcceptedAt: null,
  acceptedCount: 0,
  failedCount: 0,
  lastFailedAt: null,
  waitingCount: 0,
  oldestWaitingAt: null,
};
const NO_SYNCS = {
  failedCount: 0,
  lastFailedAt: null,
  requiresAssistance: false,
  pendingCount: 0,
};

/**
 * The source-setup seam over HTTP (US-06-05): a source whose spoke describes
 * its connection gets a setup block, can finish onboarding through the common
 * route, and stays readable after its merchant disconnects it. The connected
 * source here is a made-up platform on purpose: nothing in the onboarding
 * module may depend on which provider it is.
 */
describe('source setup and health HTTP boundary', () => {
  let app: INestApplication<Server>;
  let source: Source;
  let allSources: Source[];
  let user: AuthenticatedUser;
  let contribution: SourceSetupContribution | null;
  let supported: CommerceOutcomeAction[];
  const provider = { getShopName: jest.fn() };
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
  const events = { summarizeForIntegration: jest.fn() };
  const syncs = { summarizeForIntegration: jest.fn() };
  const describeSource = jest.fn(() => Promise.resolve(contribution));
  const contributor: SourceSetupContributor = {
    platformType: 'easyorders',
    readableWhenDisconnected: true,
    describe: describeSource,
  };

  const http = () => request(app.getHttpServer());
  const stateOf = async (): Promise<OnboardingStateDto> =>
    (
      (await http().get('/api/onboarding/state').expect(200)).body as {
        state: OnboardingStateDto;
      }
    ).state;

  function disconnect() {
    source = { ...source, isActive: false };
    allSources = [source];
    contribution = DISCONNECTED;
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    contribution = CONNECTED;
    supported = [];
    source = {
      id: 'int-1',
      orgId: 'org-1',
      platformType: 'easyorders',
      platformStoreUrl: 'easyorders:org-1',
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
    allSources = [source];
    user = {
      userId: 'user-1',
      orgId: 'org-1',
      role: 'owner',
      source: 'supabase',
    };
    repository.findActiveByOrg.mockImplementation(() =>
      Promise.resolve(allSources.filter((entry) => entry.isActive === true)),
    );
    repository.findByOrg.mockImplementation(() => Promise.resolve(allSources));
    repository.findByOrgAndPlatformDomain.mockImplementation(() =>
      Promise.resolve(source),
    );
    repository.updateById.mockImplementation(
      (_id: string, changes: Partial<Source>) => {
        source = { ...source, ...changes };
        allSources = [source];
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
    events.summarizeForIntegration.mockResolvedValue(NO_EVENTS);
    syncs.summarizeForIntegration.mockResolvedValue(NO_SYNCS);

    const sourceSetup = new SourceSetupService(
      [contributor],
      repository as never,
      events as never,
      syncs as never,
      {
        supports: (_platform: string, action: CommerceOutcomeAction) =>
          supported.includes(action),
      } as never,
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
      provider,
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
        provider as never,
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

  it('identifies the store, the order defaults, automation and the Akeed sender', async () => {
    const state = await stateOf();

    expect(state.sourceSetup).toEqual({
      connectionState: 'connected',
      disconnectedAt: null,
      store: { reference: 'store-1', verified: true },
      orderDefaults: { currency: 'EGP', phoneCountry: 'EG' },
      sender: { sender: 'akeed_shared', status: 'configured' },
      canComplete: true,
      blockedReasons: [],
    });
    expect(state).toMatchObject({
      source: { platformType: 'easyorders' },
      isAutoVerifyEnabled: true,
      followUpEnabled: true,
      escalationEnabled: true,
      standaloneSetup: null,
    });
  });

  it('finishes onboarding through the common route once nothing blocks it', async () => {
    await http().post('/api/onboarding/complete').expect(201);

    expect(repository.updateById).toHaveBeenCalledWith(
      'int-1',
      expect.objectContaining({ onboardingStatus: 'completed' }),
    );
  });

  it.each([
    ['a key the provider rejected', ['credentials_rejected']],
    ['missing webhook secrets', ['webhook_secrets_missing']],
    [
      'missing order defaults and secrets',
      ['order_defaults_missing', 'webhook_secrets_missing'],
    ],
  ] as const)('blocks completion for %s', async (_label, blockedReasons) => {
    contribution = { ...CONNECTED, blockedReasons: [...blockedReasons] };

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
    expect((await stateOf()).sourceSetup).toMatchObject({
      canComplete: false,
      blockedReasons,
    });
  });

  it('lists the common setup reasons before the source ones', async () => {
    source = { ...source, storeName: '  ' };
    allSources = [source];
    contribution = {
      ...CONNECTED,
      blockedReasons: ['webhook_secrets_missing'],
    };

    expect((await stateOf()).sourceSetup?.blockedReasons).toEqual([
      'merchant_name_missing',
      'webhook_secrets_missing',
    ]);
  });

  it('starts a store with no name from the organization name, whatever the platform', async () => {
    source = { ...source, storeName: null };
    allSources = [source];

    expect((await stateOf()).storeName).toBe('Noor Company');
    expect(provider.getShopName).not.toHaveBeenCalled();
  });

  it.each(['configured', 'not_configured'] as const)(
    'passes the sender status through as %s, without claiming delivery',
    (status) => {
      const reader = new SourceSetupService(
        [],
        repository as never,
        events as never,
        syncs as never,
        { supports: () => false } as never,
        {
          sendVerificationTemplate: jest.fn(),
          getSenderStatus: () => ({ sender: 'akeed_shared', status }),
        },
      );

      expect(reader.senderStatus()).toEqual({ sender: 'akeed_shared', status });
    },
  );

  it('reports an adapter that cannot tell as unknown', () => {
    const reader = new SourceSetupService(
      [],
      repository as never,
      events as never,
      syncs as never,
      { supports: () => false } as never,
      { sendVerificationTemplate: jest.fn() },
    );

    expect(reader.senderStatus().status).toBe('unknown');
  });

  it('lets a viewer read setup and health and refuses completion', async () => {
    user = { ...user, role: 'viewer' };

    expect((await stateOf()).permissions).toEqual({
      canUpdateConfiguration: false,
      canCompleteOnboarding: false,
    });
    await http().get('/api/settings/source-health').expect(200);
    await http().post('/api/onboarding/complete').expect(403);
    expect(repository.updateById).not.toHaveBeenCalled();
  });

  describe('health', () => {
    const healthOf = async (): Promise<SourceHealthDto> =>
      (await http().get('/api/settings/source-health').expect(200))
        .body as SourceHealthDto;

    it('does not treat a store with no events as broken', async () => {
      const health = await healthOf();

      expect(health).toMatchObject({
        integrationId: 'int-1',
        connectionState: 'connected',
        windowDays: 7,
        credentials: { status: 'ok' },
        events: { lastAcceptedAt: null, acceptedCount: 0 },
        processing: { failedCount: 0, lastFailedAt: null },
        backlog: { waitingCount: 0, oldestWaitingAt: null },
        remoteSync: { failedCount: 0, pendingCount: 0 },
      });
      expect(health).not.toHaveProperty('status');
      expect(health).not.toHaveProperty('ok');
    });

    it('keeps credentials, processing, backlog and store updates apart', async () => {
      contribution = {
        ...CONNECTED,
        credentials: { status: 'rejected' },
        delivery: {
          secretsMissing: true,
          rejectedCount: 4,
          lastRejectedAt: '2026-10-03T09:00:00.000Z',
        },
      };
      events.summarizeForIntegration.mockResolvedValue({
        lastAcceptedAt: '2026-10-03T10:00:00.000Z',
        acceptedCount: 9,
        failedCount: 2,
        lastFailedAt: '2026-10-03T10:05:00.000Z',
        waitingCount: 3,
        oldestWaitingAt: '2026-10-03T09:30:00.000Z',
      });
      syncs.summarizeForIntegration.mockResolvedValue({
        failedCount: 1,
        lastFailedAt: '2026-10-03T10:10:00.000Z',
        requiresAssistance: true,
        pendingCount: 2,
      });

      expect(await healthOf()).toMatchObject({
        credentials: { status: 'rejected' },
        events: {
          lastAcceptedAt: '2026-10-03T10:00:00.000Z',
          acceptedCount: 9,
        },
        processing: { failedCount: 2 },
        backlog: {
          waitingCount: 3,
          oldestWaitingAt: '2026-10-03T09:30:00.000Z',
        },
        remoteSync: {
          failedCount: 1,
          pendingCount: 2,
          requiresAssistance: true,
        },
        delivery: { secretsMissing: true, rejectedCount: 4 },
      });
    });

    it('reads only the caller organization and its own source', async () => {
      await healthOf();

      for (const reader of [events, syncs])
        expect(reader.summarizeForIntegration).toHaveBeenCalledWith(
          'org-1',
          'int-1',
          expect.any(Date),
        );
      expect(repository.findActiveByOrg).toHaveBeenCalledWith('org-1');
    });

    it('shows every outcome the store cannot take as unsupported', async () => {
      expect((await healthOf()).capabilities).toEqual([
        { action: 'customer_confirmation', supported: false },
        { action: 'customer_cancellation', supported: false },
        { action: 'merchant_no_reply_cancellation', supported: false },
        { action: 'merchant_cancellation_tagging', supported: false },
        { action: 'automatic_no_reply_tagging', supported: false },
      ]);

      supported = [
        'customer_confirmation',
        'customer_cancellation',
        'merchant_no_reply_cancellation',
      ];
      expect(
        (await healthOf()).capabilities
          .filter((capability) => !capability.supported)
          .map((capability) => capability.action),
      ).toEqual([
        'merchant_cancellation_tagging',
        'automatic_no_reply_tagging',
      ]);
    });
  });

  describe('after a disconnect', () => {
    beforeEach(() => {
      source = { ...source, onboardingStatus: 'completed' };
      disconnect();
    });

    it('keeps state, settings and health readable', async () => {
      expect((await stateOf()).sourceSetup).toMatchObject({
        connectionState: 'disconnected',
        disconnectedAt: DISCONNECTED_AT,
        canComplete: false,
        blockedReasons: ['source_disconnected'],
      });
      await http()
        .get('/api/settings')
        .expect(200)
        .expect(({ body }: { body: { state: OnboardingStateDto } }) => {
          expect(body.state).toMatchObject({
            integrationId: 'int-1',
            onboardingStatus: 'completed',
            activation: { isLive: false },
            sourceSetup: { connectionState: 'disconnected' },
          });
        });
    });

    it('still reports the history, with no credentials and nothing writable', async () => {
      supported = ['customer_confirmation'];
      events.summarizeForIntegration.mockResolvedValue({
        ...NO_EVENTS,
        lastAcceptedAt: '2026-10-02T10:00:00.000Z',
        acceptedCount: 12,
      });

      await http()
        .get('/api/settings/source-health')
        .expect(200)
        .expect(({ body }) => {
          expect(body).toMatchObject({
            connectionState: 'disconnected',
            disconnectedAt: DISCONNECTED_AT,
            credentials: { status: 'removed' },
            events: {
              lastAcceptedAt: '2026-10-02T10:00:00.000Z',
              acceptedCount: 12,
            },
          });
          expect(
            (body as SourceHealthDto).capabilities.some(
              (capability) => capability.supported,
            ),
          ).toBe(false);
        });
    });

    it('refuses every write', async () => {
      const settings = {
        storeName: 'Edited',
        defaultLanguage: 'auto',
        isAutoVerifyEnabled: false,
      };
      const inactive = ({ body }: { body: unknown }) => {
        expect(body).toMatchObject({ code: 'ONBOARDING_SOURCE_INACTIVE' });
      };

      await http()
        .patch('/api/settings')
        .send(settings)
        .expect(404)
        .expect(inactive);
      await http()
        .patch('/api/onboarding/settings')
        .send(settings)
        .expect(404)
        .expect(inactive);
      await http()
        .post('/api/onboarding/complete')
        .expect(404)
        .expect(inactive);
      expect(repository.updateById).not.toHaveBeenCalled();
    });

    it('does not expose a source that is inactive for any other reason', async () => {
      contribution = CONNECTED;

      await http()
        .get('/api/onboarding/state')
        .expect(404)
        .expect(({ body }) => {
          expect(body).toMatchObject({ code: 'ONBOARDING_SOURCE_INACTIVE' });
        });
    });

    it('does not expose an inactive source next to another one', async () => {
      allSources = [source, { ...source, id: 'int-2' }];

      await http().get('/api/settings').expect(404);
    });
  });

  describe('sources without a contributor', () => {
    it.each(['standalone', 'shopify'])(
      'leaves the %s state without a source setup block',
      async (platformType) => {
        source = {
          ...source,
          platformType,
          onboardingStatus: 'completed',
        };
        allSources = [source];

        const state = await stateOf();

        expect(state).not.toHaveProperty('sourceSetup');
        expect(describeSource).not.toHaveBeenCalled();
      },
    );

    it('still answers 404 for an inactive Standalone source', async () => {
      source = { ...source, platformType: 'standalone', isActive: false };
      allSources = [source];

      await http()
        .get('/api/settings')
        .expect(404)
        .expect(({ body }) => {
          expect(body).toMatchObject({ code: 'ONBOARDING_SOURCE_INACTIVE' });
        });
    });

    it('reports health without credential or delivery signals', async () => {
      source = { ...source, platformType: 'standalone' };
      allSources = [source];

      await http()
        .get('/api/settings/source-health')
        .expect(200)
        .expect(({ body }) => {
          expect(body).toMatchObject({
            platformType: 'standalone',
            connectionState: 'connected',
            credentials: null,
            delivery: null,
          });
        });
    });
  });

  it('refuses two contributors for one platform', () => {
    expect(
      () =>
        new SourceSetupService(
          [contributor, contributor],
          repository as never,
          events as never,
          syncs as never,
          { supports: () => false } as never,
        ),
    ).toThrow('Duplicate source setup contributor for easyorders');
  });
});
