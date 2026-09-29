import { BadRequestException } from '@nestjs/common';
import { OnboardingStateService } from './onboarding-state.service';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  UpdateOnboardingSettingsDto,
  type OnboardingStateDto,
} from './dto/onboarding.dto';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import type { integrations } from '../../infrastructure/database/schema';

type IntegrationRecord = typeof integrations.$inferSelect;

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
    escalationEnabled: true,
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
      expect(state.escalationEnabled).toBe(true);
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
          escalationEnabled: false,
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
      expect(state.escalationEnabled).toBe(false);
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
      role: 'owner',
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

    it('should persist COD template variant selections', async () => {
      mockIntegrationsRepo.updateById.mockResolvedValue(
        makeIntegration({
          codTemplateArVariant: 'gulf',
          codTemplateEnVariant: 'direct',
        }),
      );

      await service.updateSettings(user, {
        storeName: 'Test Store',
        defaultLanguage: 'auto',
        isAutoVerifyEnabled: true,
        codTemplateArVariant: 'gulf',
        codTemplateEnVariant: 'direct',
      });

      expect(mockIntegrationsRepo.updateById).toHaveBeenCalledWith(
        'int-1',
        expect.objectContaining({
          codTemplateArVariant: 'gulf',
          codTemplateEnVariant: 'direct',
        }),
      );
    });

    it('should reject unsupported COD template variants', async () => {
      await expect(
        service.updateSettings(user, {
          storeName: 'Test Store',
          defaultLanguage: 'auto',
          isAutoVerifyEnabled: true,
          codTemplateArVariant: 'friendly',
        } as any),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.updateSettings(user, {
          storeName: 'Test Store',
          defaultLanguage: 'auto',
          isAutoVerifyEnabled: true,
          codTemplateEnVariant: 'gulf',
        } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject followUpDelayMinutes >= escalationDelayMinutes when both follow-up and escalation enabled', async () => {
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

    it('should allow followUpDelayMinutes >= escalationDelayMinutes when escalation disabled', async () => {
      mockIntegrationsRepo.updateById.mockResolvedValue(
        makeIntegration({
          escalationEnabled: false,
          followUpDelayMinutes: 400,
          escalationDelayMinutes: 360,
        }),
      );

      const result = await service.updateSettings(user, {
        storeName: 'Test Store',
        defaultLanguage: 'auto',
        isAutoVerifyEnabled: true,
        escalationEnabled: false,
        followUpDelayMinutes: 400,
        escalationDelayMinutes: 360,
      });

      expect(result.escalationEnabled).toBe(false);
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

  describe('settings redesign — timezone, quiet window, test language', () => {
    const user: AuthenticatedUser = {
      userId: 'user-1',
      orgId: 'org-1',
      role: 'owner',
      source: 'shopify',
      shop: 'test.myshopify.com',
    };
    const base = {
      storeName: 'Test Store',
      defaultLanguage: 'auto' as const,
      isAutoVerifyEnabled: true,
    };

    beforeEach(() => {
      mockIntegrationsRepo.findByOrgAndPlatformDomain.mockResolvedValue(
        makeIntegration({ shopTimezone: 'Europe/Istanbul' }),
      );
      mockIntegrationsRepo.updateById.mockImplementation(
        (_id: string, updates: Record<string, unknown>) =>
          Promise.resolve(
            makeIntegration({ shopTimezone: 'Europe/Istanbul', ...updates }),
          ),
      );
    });

    it('accepts the store timezone even when it is outside the curated list', async () => {
      const result = await service.updateSettings(user, {
        ...base,
        timezone: 'Europe/Istanbul',
      });

      expect(result.timezone).toBe('Europe/Istanbul');
      expect(result.shopTimezone).toBe('Europe/Istanbul');
    });

    it('rejects a timezone that is neither curated nor the store timezone', async () => {
      await expect(
        service.updateSettings(user, { ...base, timezone: 'America/Chicago' }),
      ).rejects.toMatchObject({
        response: { code: 'SETTINGS_TIMEZONE_UNSUPPORTED' },
      });
      expect(mockIntegrationsRepo.updateById).not.toHaveBeenCalled();
    });

    it('rejects an enabled quiet-hours window whose start equals its end', async () => {
      await expect(
        service.updateSettings(user, {
          ...base,
          quietHoursEnabled: true,
          quietHoursStart: '21:00',
          quietHoursEnd: '21:00',
        }),
      ).rejects.toMatchObject({
        response: { code: 'SETTINGS_QUIET_HOURS_EMPTY_WINDOW' },
      });
    });

    it('accepts a window that crosses midnight', async () => {
      const result = await service.updateSettings(user, {
        ...base,
        quietHoursEnabled: true,
        quietHoursStart: '21:00',
        quietHoursEnd: '09:00',
      });

      expect(result.quietHoursStart).toBe('21:00');
      expect(result.quietHoursEnd).toBe('09:00');
    });

    it('ignores equal times while quiet hours are off', async () => {
      await expect(
        service.updateSettings(user, {
          ...base,
          quietHoursEnabled: false,
          quietHoursStart: '21:00',
          quietHoursEnd: '21:00',
        }),
      ).resolves.toBeDefined();
    });

    it('reports a null store timezone when the platform value is invalid', () => {
      const state = callToState(
        service,
        makeIntegration({ shopTimezone: 'Not/AZone' }),
      );

      expect(state.shopTimezone).toBeNull();
    });

    it('resolves the test-send language from the merchant phone', () => {
      expect(
        callToState(
          service,
          makeIntegration({ merchantWhatsappPhone: '+201001234567' }),
        ).testSendLanguage,
      ).toBe('ar');
      expect(
        callToState(
          service,
          makeIntegration({ merchantWhatsappPhone: '+447700900123' }),
        ).testSendLanguage,
      ).toBe('en');
      expect(
        callToState(
          service,
          makeIntegration({
            defaultLanguage: 'en',
            merchantWhatsappPhone: '+201001234567',
          }),
        ).testSendLanguage,
      ).toBe('en');
    });
  });

  describe('prefillStoreNameIfMissing', () => {
    function buildService(organizationName: string | null) {
      const storePlatform = {
        getShopName: jest.fn().mockResolvedValue('Shop'),
      };
      const organizationsRepo = {
        findById: jest
          .fn()
          .mockResolvedValue(
            organizationName === null
              ? undefined
              : { id: 'org-1', name: organizationName },
          ),
      };
      mockIntegrationsRepo.updateById.mockImplementation(
        (_id: string, updates: Record<string, unknown>) =>
          Promise.resolve(makeIntegration({ ...updates })),
      );
      const svc = new OnboardingStateService(
        mockIntegrationsRepo as never,
        storePlatform as never,
        undefined,
        undefined,
        organizationsRepo as never,
      );
      return { svc, storePlatform, organizationsRepo };
    }

    const standaloneSource = (storeName: string | null) =>
      makeIntegration({
        platformType: 'standalone',
        platformStoreUrl: 'standalone:org-1',
        onboardingStatus: 'pending',
        storeName,
      }) as unknown as IntegrationRecord;

    it('fills an empty standalone store name from the organization name', async () => {
      const { svc, storePlatform, organizationsRepo } =
        buildService('  Nile Shop  ');

      const result = await svc.prefillStoreNameIfMissing(
        standaloneSource(null),
      );

      expect(organizationsRepo.findById).toHaveBeenCalledWith('org-1');
      expect(mockIntegrationsRepo.updateById).toHaveBeenCalledWith('int-1', {
        storeName: 'Nile Shop',
      });
      expect(result.storeName).toBe('Nile Shop');
      expect(storePlatform.getShopName).not.toHaveBeenCalled();
    });

    it('never overwrites an existing standalone store name', async () => {
      const { svc, organizationsRepo } = buildService('Signup Name');
      const source = standaloneSource('Merchant Choice');

      await expect(svc.prefillStoreNameIfMissing(source)).resolves.toBe(source);
      expect(organizationsRepo.findById).not.toHaveBeenCalled();
      expect(mockIntegrationsRepo.updateById).not.toHaveBeenCalled();
    });

    it('leaves the store name empty when the organization has no name', async () => {
      const { svc } = buildService('   ');
      const source = standaloneSource(null);

      await expect(svc.prefillStoreNameIfMissing(source)).resolves.toBe(source);
      expect(mockIntegrationsRepo.updateById).not.toHaveBeenCalled();
    });

    it('caps a long organization name at the store-name limit', async () => {
      const { svc } = buildService('x'.repeat(80));

      await svc.prefillStoreNameIfMissing(standaloneSource(null));

      expect(mockIntegrationsRepo.updateById).toHaveBeenCalledWith('int-1', {
        storeName: 'x'.repeat(60),
      });
    });

    it('keeps prefilling Shopify stores from the platform, not the organization', async () => {
      const { svc, storePlatform, organizationsRepo } =
        buildService('Org Name');

      const result = await svc.prefillStoreNameIfMissing(
        makeIntegration({ storeName: null }) as unknown as IntegrationRecord,
      );

      expect(storePlatform.getShopName).toHaveBeenCalledTimes(1);
      expect(organizationsRepo.findById).not.toHaveBeenCalled();
      expect(result.storeName).toBe('Shop');
    });
  });

  describe('updateSettings — standalone your-store form', () => {
    const user: AuthenticatedUser = {
      userId: 'user-1',
      orgId: 'org-1',
      role: 'owner',
      source: 'supabase',
    };
    const base = {
      storeName: 'Nile Shop',
      defaultLanguage: 'auto' as const,
      isAutoVerifyEnabled: true,
    };

    beforeEach(() => {
      mockIntegrationsRepo.findActiveByOrg = jest.fn().mockResolvedValue([
        makeIntegration({
          platformType: 'standalone',
          platformStoreUrl: 'standalone:org-1',
          onboardingStatus: 'pending',
          storeName: null,
          shopTimezone: null,
        }),
      ]);
      mockIntegrationsRepo.updateById.mockImplementation(
        (_id: string, updates: Record<string, unknown>) =>
          Promise.resolve(
            makeIntegration({
              platformType: 'standalone',
              shopTimezone: null,
              ...updates,
            }),
          ),
      );
    });

    it('persists the WhatsApp number, shipping currency and timezone', async () => {
      const result = await service.updateSettings(user, {
        ...base,
        merchantWhatsappPhone: ' +20 100 123 4567 ',
        shippingCurrency: 'EGP',
        timezone: 'Africa/Cairo',
      });

      expect(mockIntegrationsRepo.updateById).toHaveBeenCalledWith(
        'int-1',
        expect.objectContaining({
          storeName: 'Nile Shop',
          merchantWhatsappPhone: '+201001234567',
          shippingCurrency: 'EGP',
          timezone: 'Africa/Cairo',
        }),
      );
      expect(result).toMatchObject({
        merchantWhatsappPhone: '+201001234567',
        shippingCurrency: 'EGP',
        timezone: 'Africa/Cairo',
      });
    });

    it('rejects a timezone outside the curated list (no store zone to fall back on)', async () => {
      await expect(
        service.updateSettings(user, { ...base, timezone: 'Europe/London' }),
      ).rejects.toMatchObject({
        response: { code: 'SETTINGS_TIMEZONE_UNSUPPORTED' },
      });
      expect(mockIntegrationsRepo.updateById).not.toHaveBeenCalled();
    });

    it('rejects an invalid WhatsApp number', async () => {
      await expect(
        service.updateSettings(user, {
          ...base,
          merchantWhatsappPhone: 'not-a-phone',
        }),
      ).rejects.toMatchObject({
        response: { code: 'ONBOARDING_INVALID_PHONE' },
      });
      expect(mockIntegrationsRepo.updateById).not.toHaveBeenCalled();
    });
  });

  describe('UpdateOnboardingSettingsDto shippingCurrency', () => {
    async function currencyErrors(shippingCurrency: string) {
      const dto = plainToInstance(UpdateOnboardingSettingsDto, {
        storeName: 'Nile Shop',
        defaultLanguage: 'auto',
        isAutoVerifyEnabled: true,
        shippingCurrency,
      });
      const errors = await validate(dto);
      return errors.filter((error) => error.property === 'shippingCurrency');
    }

    it('accepts a currency on the allowlist', async () => {
      await expect(currencyErrors('EGP')).resolves.toHaveLength(0);
    });

    it('rejects a currency outside the allowlist', async () => {
      await expect(currencyErrors('GBP')).resolves.toHaveLength(1);
    });
  });
});
