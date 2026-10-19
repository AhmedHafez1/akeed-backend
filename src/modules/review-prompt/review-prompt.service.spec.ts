import { Logger } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import {
  REVIEW_PROMPT_ERROR_CODES,
  ReviewPromptService,
} from './review-prompt.service';

const ORG = '00000000-0000-4000-8000-000000000001';
const STORE = '00000000-0000-4000-8000-000000000002';
const REQUEST = '00000000-0000-4000-8000-000000000003';

const owner: AuthenticatedUser = {
  userId: 'shopify-user-1',
  orgId: ORG,
  role: 'owner',
  source: 'shopify',
  shop: 'store-a.myshopify.com',
};

function build() {
  const reviewPrompts = {
    findPending: jest.fn().mockResolvedValue({ id: REQUEST }),
    recordShown: jest.fn().mockResolvedValue({ outcome: 'recorded' }),
    recordMerchantAction: jest.fn().mockResolvedValue({ outcome: 'recorded' }),
  };
  const integrations = {
    findByOrgAndPlatformDomain: jest
      .fn()
      .mockResolvedValue({ id: STORE, orgId: ORG, isActive: true }),
  };
  const service = new ReviewPromptService(
    reviewPrompts as never,
    integrations as never,
  );
  return { service, reviewPrompts, integrations };
}

describe('ReviewPromptService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('getState', () => {
    it('returns the pending request of the session shop', async () => {
      const { service, reviewPrompts, integrations } = build();
      await expect(service.getState(owner)).resolves.toEqual({
        prompt: { id: REQUEST },
      });
      expect(integrations.findByOrgAndPlatformDomain).toHaveBeenCalledWith(
        ORG,
        'store-a.myshopify.com',
        'shopify',
      );
      expect(reviewPrompts.findPending).toHaveBeenCalledWith(ORG, STORE);
    });

    it('returns null when nothing is pending', async () => {
      const { service, reviewPrompts } = build();
      reviewPrompts.findPending.mockResolvedValue(undefined);
      await expect(service.getState(owner)).resolves.toEqual({ prompt: null });
    });

    it.each<[string, AuthenticatedUser]>([
      [
        'a standalone session',
        { userId: 'u', orgId: ORG, role: 'owner', source: 'supabase' },
      ],
      ['a viewer', { ...owner, role: 'viewer' }],
    ])('returns null for %s without reading requests', async (_, user) => {
      const { service, reviewPrompts } = build();
      await expect(service.getState(user)).resolves.toEqual({ prompt: null });
      expect(reviewPrompts.findPending).not.toHaveBeenCalled();
    });

    it('returns null for an uninstalled store', async () => {
      const { service, integrations, reviewPrompts } = build();
      integrations.findByOrgAndPlatformDomain.mockResolvedValue({
        id: STORE,
        orgId: ORG,
        isActive: false,
      });
      await expect(service.getState(owner)).resolves.toEqual({ prompt: null });
      expect(reviewPrompts.findPending).not.toHaveBeenCalled();
    });

    it('maps a database failure to a coded 503', async () => {
      const { service, reviewPrompts } = build();
      reviewPrompts.findPending.mockRejectedValue(new Error('connection lost'));
      await expect(service.getState(owner)).rejects.toMatchObject({
        response: { code: REVIEW_PROMPT_ERROR_CODES.unavailable },
      });
    });
  });

  describe('recordAction', () => {
    it.each([
      'review_clicked',
      'snoozed',
      'dismissed',
      'dont_ask_again',
    ] as const)(
      'records %s scoped to the session org and store',
      async (action) => {
        const { service, reviewPrompts } = build();
        await expect(
          service.recordAction(owner, REQUEST, action, 'req-1'),
        ).resolves.toEqual({ outcome: 'recorded' });
        expect(reviewPrompts.recordMerchantAction).toHaveBeenCalledWith(
          {
            orgId: ORG,
            integrationId: STORE,
            requestId: REQUEST,
            actorId: 'shopify-user-1',
            httpRequestId: 'req-1',
          },
          action,
        );
      },
    );

    it('returns replayed for a duplicate submission', async () => {
      const { service, reviewPrompts } = build();
      reviewPrompts.recordMerchantAction.mockResolvedValue({
        outcome: 'replayed',
      });
      await expect(
        service.recordAction(owner, REQUEST, 'snoozed'),
      ).resolves.toEqual({ outcome: 'replayed' });
    });

    it('refuses an answer to a closed request with REVIEW_PROMPT_NOT_PENDING', async () => {
      const { service, reviewPrompts } = build();
      reviewPrompts.recordMerchantAction.mockResolvedValue({
        outcome: 'conflict',
      });
      await expect(
        service.recordAction(owner, REQUEST, 'dismissed'),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: REVIEW_PROMPT_ERROR_CODES.notPending },
      });
    });

    it('treats a request of another store as not found', async () => {
      const { service, reviewPrompts } = build();
      reviewPrompts.recordMerchantAction.mockResolvedValue({
        outcome: 'not_found',
      });
      await expect(
        service.recordAction(owner, REQUEST, 'snoozed'),
      ).rejects.toMatchObject({
        status: 404,
        response: { code: REVIEW_PROMPT_ERROR_CODES.notFound },
      });
    });

    it('refuses a viewer before touching the database', async () => {
      const { service, reviewPrompts } = build();
      await expect(
        service.recordAction({ ...owner, role: 'viewer' }, REQUEST, 'snoozed'),
      ).rejects.toMatchObject({
        status: 403,
        response: { code: REVIEW_PROMPT_ERROR_CODES.forbidden },
      });
      expect(reviewPrompts.recordMerchantAction).not.toHaveBeenCalled();
    });

    it('refuses a standalone session', async () => {
      const { service, reviewPrompts } = build();
      await expect(
        service.recordAction(
          { userId: 'u', orgId: ORG, role: 'owner', source: 'supabase' },
          REQUEST,
          'snoozed',
        ),
      ).rejects.toMatchObject({ status: 404 });
      expect(reviewPrompts.recordMerchantAction).not.toHaveBeenCalled();
    });

    it('refuses when the session shop is not a store of its org', async () => {
      const { service, integrations, reviewPrompts } = build();
      integrations.findByOrgAndPlatformDomain.mockResolvedValue(undefined);
      await expect(
        service.recordAction(owner, REQUEST, 'snoozed'),
      ).rejects.toMatchObject({ status: 404 });
      expect(reviewPrompts.recordMerchantAction).not.toHaveBeenCalled();
    });

    it('maps a failed write to a coded 503 so the banner can retry', async () => {
      const { service, reviewPrompts } = build();
      reviewPrompts.recordMerchantAction.mockRejectedValue(
        new Error('could not serialize access'),
      );
      await expect(
        service.recordAction(owner, REQUEST, 'dont_ask_again'),
      ).rejects.toMatchObject({
        status: 503,
        response: { code: REVIEW_PROMPT_ERROR_CODES.unavailable },
      });
    });
  });

  describe('recordShown', () => {
    it('records the impression for the session store', async () => {
      const { service, reviewPrompts } = build();
      await service.recordShown(owner, REQUEST);
      expect(reviewPrompts.recordShown).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: ORG,
          integrationId: STORE,
          requestId: REQUEST,
        }),
      );
    });

    it.each(['replayed', 'not_pending'] as const)(
      'accepts a %s impression quietly',
      async (outcome) => {
        const { service, reviewPrompts } = build();
        reviewPrompts.recordShown.mockResolvedValue({ outcome });
        await expect(
          service.recordShown(owner, REQUEST),
        ).resolves.toBeUndefined();
      },
    );

    it('treats an unknown request as not found', async () => {
      const { service, reviewPrompts } = build();
      reviewPrompts.recordShown.mockResolvedValue({ outcome: 'not_found' });
      await expect(service.recordShown(owner, REQUEST)).rejects.toMatchObject({
        status: 404,
      });
    });
  });
});
