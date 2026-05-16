import { BadRequestException } from '@nestjs/common';
import { OnboardingStateService } from './onboarding-state.service';
import type { OnboardingStateDto } from './dto/onboarding.dto';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';

/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access */

function callToState(
  svc: OnboardingStateService,
  integration: Record<string, unknown>,
): OnboardingStateDto {
  return (svc as any).toState(integration);
}

/* eslint-enable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access */

function makeIntegration(overrides: Record<string, unknown> = {}) {
  return {
    id: 'int-1',
    orgId: 'org-1',
    platformType: 'shopify',
    platformStoreUrl: 'test.myshopify.com',
    accessToken: null,
    expiresAt: null,
    webhookSecret: null,
    isActive: true,
    lastSyncedAt: null,
    metadata: {},
    storeName: 'Test Store',
    defaultLanguage: 'auto',
    shippingCurrency: 'SAR',
    avgShippingCost: '5.00',
    isAutoVerifyEnabled: true,
    onboardingStatus: 'completed',
    billingPlanId: 'starter',
    shopifySubscriptionId: null,
    billingStatus: 'active',
    billingInitiatedAt: null,
    billingActivatedAt: null,
    billingCanceledAt: null,
    billingStatusUpdatedAt: null,
    followUpEnabled: true,
    followUpDelayMinutes: 120,
    escalationDelayMinutes: 360,
    quietHoursEnabled: false,
    quietHoursStart: null,
    quietHoursEnd: null,
    timezone: 'Asia/Riyadh',
    sendDelayMinutes: 0,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('OnboardingStateService', () => {
  let service: OnboardingStateService;
  let mockIntegrationsRepo: Record<string, jest.Mock>;

  beforeEach(() => {
    mockIntegrationsRepo = {
      findByOrgAndPlatformDomain: jest.fn(),
      findActiveByOrgAndPlatform: jest.fn(),
      updateById: jest.fn(),
    };

    service = new OnboardingStateService(
      mockIntegrationsRepo as any,
      {} as any,
    );
  });

  describe('toState — automation defaults', () => {
    it('should return default automation settings', () => {
      const state = callToState(service, makeIntegration());

      expect(state.followUpEnabled).toBe(true);
      expect(state.followUpDelayMinutes).toBe(120);
      expect(state.escalationDelayMinutes).toBe(360);
      expect(state.quietHoursEnabled).toBe(false);
      expect(state.quietHoursStart).toBeNull();
      expect(state.quietHoursEnd).toBeNull();
      expect(state.timezone).toBe('Asia/Riyadh');
      expect(state.sendDelayMinutes).toBe(0);
    });

    it('should return custom automation settings from integration', () => {
      const state = callToState(
        service,
        makeIntegration({
          followUpEnabled: false,
          followUpDelayMinutes: 60,
          escalationDelayMinutes: 480,
          quietHoursEnabled: true,
          quietHoursStart: '22:00',
          quietHoursEnd: '08:00',
          timezone: 'Africa/Cairo',
          sendDelayMinutes: 15,
        }),
      );

      expect(state.followUpEnabled).toBe(false);
      expect(state.followUpDelayMinutes).toBe(60);
      expect(state.escalationDelayMinutes).toBe(480);
      expect(state.quietHoursEnabled).toBe(true);
      expect(state.quietHoursStart).toBe('22:00');
      expect(state.quietHoursEnd).toBe('08:00');
      expect(state.timezone).toBe('Africa/Cairo');
      expect(state.sendDelayMinutes).toBe(15);
    });

    it('should normalize unknown timezone to Asia/Riyadh', () => {
      const state = callToState(
        service,
        makeIntegration({ timezone: 'America/New_York' }),
      );

      expect(state.timezone).toBe('Asia/Riyadh');
    });

    it('should normalize null timezone to Asia/Riyadh', () => {
      const state = callToState(service, makeIntegration({ timezone: null }));

      expect(state.timezone).toBe('Asia/Riyadh');
    });
  });

  describe('updateSettings — automation validation', () => {
    const user: AuthenticatedUser = {
      userId: 'user-1',
      orgId: 'org-1',
      source: 'shopify',
      shop: 'test.myshopify.com',
    };

    beforeEach(() => {
      mockIntegrationsRepo.findByOrgAndPlatformDomain.mockResolvedValue(
        makeIntegration(),
      );
    });

    it('should persist automation fields', async () => {
      mockIntegrationsRepo.updateById.mockResolvedValue(
        makeIntegration({
          followUpEnabled: false,
          followUpDelayMinutes: 90,
          escalationDelayMinutes: 360,
          sendDelayMinutes: 10,
        }),
      );

      const result = await service.updateSettings(user, {
        storeName: 'Test Store',
        defaultLanguage: 'auto',
        isAutoVerifyEnabled: true,
        followUpEnabled: false,
        followUpDelayMinutes: 90,
        sendDelayMinutes: 10,
      });

      expect(mockIntegrationsRepo.updateById).toHaveBeenCalledWith(
        'int-1',
        expect.objectContaining({
          followUpEnabled: false,
          followUpDelayMinutes: 90,
          sendDelayMinutes: 10,
        }),
      );

      expect(result.followUpEnabled).toBe(false);
      expect(result.followUpDelayMinutes).toBe(90);
      expect(result.sendDelayMinutes).toBe(10);
    });

    it('should reject followUpDelayMinutes >= escalationDelayMinutes when follow-up enabled', async () => {
      await expect(
        service.updateSettings(user, {
          storeName: 'Test Store',
          defaultLanguage: 'auto',
          isAutoVerifyEnabled: true,
          followUpDelayMinutes: 360,
          escalationDelayMinutes: 360,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should allow followUpDelayMinutes >= escalationDelayMinutes when follow-up disabled', async () => {
      mockIntegrationsRepo.updateById.mockResolvedValue(
        makeIntegration({
          followUpEnabled: false,
          followUpDelayMinutes: 400,
          escalationDelayMinutes: 360,
        }),
      );

      const result = await service.updateSettings(user, {
        storeName: 'Test Store',
        defaultLanguage: 'auto',
        isAutoVerifyEnabled: true,
        followUpEnabled: false,
        followUpDelayMinutes: 400,
        escalationDelayMinutes: 360,
      });

      expect(result.followUpEnabled).toBe(false);
    });

    it('should reject quiet hours enabled without start time', async () => {
      await expect(
        service.updateSettings(user, {
          storeName: 'Test Store',
          defaultLanguage: 'auto',
          isAutoVerifyEnabled: true,
          quietHoursEnabled: true,
          quietHoursEnd: '08:00',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject quiet hours enabled without end time', async () => {
      await expect(
        service.updateSettings(user, {
          storeName: 'Test Store',
          defaultLanguage: 'auto',
          isAutoVerifyEnabled: true,
          quietHoursEnabled: true,
          quietHoursStart: '22:00',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should accept quiet hours enabled with both times', async () => {
      mockIntegrationsRepo.updateById.mockResolvedValue(
        makeIntegration({
          quietHoursEnabled: true,
          quietHoursStart: '22:00',
          quietHoursEnd: '08:00',
        }),
      );

      const result = await service.updateSettings(user, {
        storeName: 'Test Store',
        defaultLanguage: 'auto',
        isAutoVerifyEnabled: true,
        quietHoursEnabled: true,
        quietHoursStart: '22:00',
        quietHoursEnd: '08:00',
      });

      expect(result.quietHoursEnabled).toBe(true);
      expect(result.quietHoursStart).toBe('22:00');
      expect(result.quietHoursEnd).toBe('08:00');
    });
  });
});
