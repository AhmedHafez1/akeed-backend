import { Logger } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import {
  REVIEW_PROMPT_ERROR_CODES,
  REVIEW_PROMPT_RESULTS_DEADLINE_MS,
  ReviewPromptService,
} from './review-prompt.service';

const ORG = '00000000-0000-4000-8000-000000000001';
const STORE = '00000000-0000-4000-8000-000000000002';
const SINCE = '2026-09-03T08:00:00.000Z';

const owner: AuthenticatedUser = {
  userId: 'shopify-user-1',
  orgId: ORG,
  role: 'owner',
  source: 'shopify',
  shop: 'store-a.myshopify.com',
};

const HIDDEN = {
  visible: false,
  variant: 'fallback',
  confirmed: null,
  canceled: null,
  since: null,
};

function build() {
  const reviewPrompts = {
    findMerchantView: jest
      .fn()
      .mockResolvedValue({ switchedOn: true, state: undefined }),
    countStoreResults: jest
      .fn()
      .mockResolvedValue({ confirmed: 128, canceled: 14, since: SINCE }),
    recordMerchantEvent: jest.fn().mockResolvedValue({ outcome: 'recorded' }),
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
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('getState', () => {
    it('shows the results of the session shop', async () => {
      const { service, reviewPrompts, integrations } = build();
      await expect(service.getState(owner)).resolves.toEqual({
        visible: true,
        variant: 'results',
        confirmed: 128,
        canceled: 14,
        since: SINCE,
      });
      expect(integrations.findByOrgAndPlatformDomain).toHaveBeenCalledWith(
        ORG,
        'store-a.myshopify.com',
        'shopify',
      );
      expect(reviewPrompts.findMerchantView).toHaveBeenCalledWith(ORG, STORE);
      expect(reviewPrompts.countStoreResults).toHaveBeenCalledWith(ORG, STORE);
    });

    it('shows the plain variant below ten confirmations', async () => {
      const { service, reviewPrompts } = build();
      reviewPrompts.countStoreResults.mockResolvedValue({
        confirmed: 9,
        canceled: 3,
        since: SINCE,
      });
      await expect(service.getState(owner)).resolves.toMatchObject({
        visible: true,
        variant: 'fallback',
        confirmed: 9,
      });
    });

    it('shows the plain variant when the counts fail', async () => {
      const { service, reviewPrompts } = build();
      reviewPrompts.countStoreResults.mockRejectedValue(new Error('timeout'));
      await expect(service.getState(owner)).resolves.toEqual({
        visible: true,
        variant: 'fallback',
        confirmed: null,
        canceled: null,
        since: null,
      });
    });

    it('shows the plain variant when the counts miss the deadline', async () => {
      jest.useFakeTimers();
      const { service, reviewPrompts } = build();
      reviewPrompts.countStoreResults.mockReturnValue(new Promise(() => {}));
      const pending = service.getState(owner);
      await jest.advanceTimersByTimeAsync(REVIEW_PROMPT_RESULTS_DEADLINE_MS);
      await expect(pending).resolves.toMatchObject({
        visible: true,
        variant: 'fallback',
        confirmed: null,
      });
    });

    it('hides the card while staff have the prompt off', async () => {
      const { service, reviewPrompts } = build();
      reviewPrompts.findMerchantView.mockResolvedValue({
        switchedOn: false,
        state: undefined,
      });
      await expect(service.getState(owner)).resolves.toEqual(HIDDEN);
      expect(reviewPrompts.countStoreResults).not.toHaveBeenCalled();
    });

    it.each([
      { state: 'declined', snoozedUntil: null, snoozeCount: 2 },
      { state: 'clicked', snoozedUntil: null, snoozeCount: 0 },
      { state: 'reviewed', snoozedUntil: null, snoozeCount: 0 },
      {
        state: 'snoozed',
        snoozedUntil: '2999-01-01T00:00:00.000Z',
        snoozeCount: 1,
      },
    ])('hides the card for a store that is $state', async (state) => {
      const { service, reviewPrompts } = build();
      reviewPrompts.findMerchantView.mockResolvedValue({
        switchedOn: true,
        state,
      });
      await expect(service.getState(owner)).resolves.toEqual(HIDDEN);
    });

    it('shows the card again once a snooze has run out', async () => {
      const { service, reviewPrompts } = build();
      reviewPrompts.findMerchantView.mockResolvedValue({
        switchedOn: true,
        state: {
          state: 'snoozed',
          snoozedUntil: '2020-01-01T00:00:00.000Z',
          snoozeCount: 1,
        },
      });
      await expect(service.getState(owner)).resolves.toMatchObject({
        visible: true,
      });
    });

    it.each<[string, AuthenticatedUser]>([
      [
        'a standalone session',
        { userId: 'u', orgId: ORG, role: 'owner', source: 'supabase' },
      ],
      ['a viewer', { ...owner, role: 'viewer' }],
    ])('hides the card for %s without reading state', async (_, user) => {
      const { service, reviewPrompts } = build();
      await expect(service.getState(user)).resolves.toEqual(HIDDEN);
      expect(reviewPrompts.findMerchantView).not.toHaveBeenCalled();
    });

    it('hides the card for an uninstalled store', async () => {
      const { service, integrations, reviewPrompts } = build();
      integrations.findByOrgAndPlatformDomain.mockResolvedValue({
        id: STORE,
        orgId: ORG,
        isActive: false,
      });
      await expect(service.getState(owner)).resolves.toEqual(HIDDEN);
      expect(reviewPrompts.findMerchantView).not.toHaveBeenCalled();
    });

    it('maps a database failure to a coded 503', async () => {
      const { service, reviewPrompts } = build();
      reviewPrompts.findMerchantView.mockRejectedValue(
        new Error('connection lost'),
      );
      await expect(service.getState(owner)).rejects.toMatchObject({
        response: { code: REVIEW_PROMPT_ERROR_CODES.unavailable },
      });
    });
  });

  describe('recordAction', () => {
    it.each(['shown', 'clicked', 'not_now'] as const)(
      'records %s scoped to the session org and store',
      async (action) => {
        const { service, reviewPrompts } = build();
        await expect(
          service.recordAction(owner, action, undefined, 'req-1'),
        ).resolves.toEqual({ outcome: 'recorded' });
        expect(reviewPrompts.recordMerchantEvent).toHaveBeenCalledWith(
          {
            orgId: ORG,
            integrationId: STORE,
            actorId: 'shopify-user-1',
            httpRequestId: 'req-1',
          },
          action,
          undefined,
        );
      },
    );

    it('passes the Reviews API code with a result', async () => {
      const { service, reviewPrompts } = build();
      await service.recordAction(owner, 'result', 'cooldown-period');
      expect(reviewPrompts.recordMerchantEvent).toHaveBeenCalledWith(
        expect.objectContaining({ integrationId: STORE }),
        'result',
        'cooldown-period',
      );
    });

    it('drops a code sent with another action', async () => {
      const { service, reviewPrompts } = build();
      await service.recordAction(owner, 'clicked', 'success');
      expect(reviewPrompts.recordMerchantEvent).toHaveBeenCalledWith(
        expect.anything(),
        'clicked',
        undefined,
      );
    });

    it('returns replayed for a duplicate "Not now"', async () => {
      const { service, reviewPrompts } = build();
      reviewPrompts.recordMerchantEvent.mockResolvedValue({
        outcome: 'replayed',
      });
      await expect(
        service.recordAction(owner, 'not_now', undefined),
      ).resolves.toEqual({ outcome: 'replayed' });
    });

    it('refuses a viewer before touching the database', async () => {
      const { service, reviewPrompts } = build();
      await expect(
        service.recordAction(
          { ...owner, role: 'viewer' },
          'not_now',
          undefined,
        ),
      ).rejects.toMatchObject({
        status: 403,
        response: { code: REVIEW_PROMPT_ERROR_CODES.forbidden },
      });
      expect(reviewPrompts.recordMerchantEvent).not.toHaveBeenCalled();
    });

    it('refuses a standalone session', async () => {
      const { service, reviewPrompts } = build();
      await expect(
        service.recordAction(
          { userId: 'u', orgId: ORG, role: 'owner', source: 'supabase' },
          'not_now',
          undefined,
        ),
      ).rejects.toMatchObject({ status: 404 });
      expect(reviewPrompts.recordMerchantEvent).not.toHaveBeenCalled();
    });

    it('refuses when the session shop is not a store of its org', async () => {
      const { service, integrations, reviewPrompts } = build();
      integrations.findByOrgAndPlatformDomain.mockResolvedValue(undefined);
      await expect(
        service.recordAction(owner, 'not_now', undefined),
      ).rejects.toMatchObject({
        status: 404,
        response: { code: REVIEW_PROMPT_ERROR_CODES.notFound },
      });
      expect(reviewPrompts.recordMerchantEvent).not.toHaveBeenCalled();
    });

    it('maps a failed write to a coded 503 so the card can report again', async () => {
      const { service, reviewPrompts } = build();
      reviewPrompts.recordMerchantEvent.mockRejectedValue(
        new Error('could not serialize access'),
      );
      await expect(
        service.recordAction(owner, 'clicked', undefined),
      ).rejects.toMatchObject({
        status: 503,
        response: { code: REVIEW_PROMPT_ERROR_CODES.unavailable },
      });
    });
  });
});
