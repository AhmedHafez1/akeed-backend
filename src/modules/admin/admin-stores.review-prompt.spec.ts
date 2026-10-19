import { Logger, NotFoundException } from '@nestjs/common';
import {
  AdminStoresService,
  REVIEW_PROMPT_ADMIN_ERROR_CODES,
} from './admin-stores.service';

const ORG = '1a2b3c4d-5e6f-4a1b-8c9d-0e1f2a3b4c5d';
const STORE = '3f2b1c4d-5e6f-4a1b-8c9d-0e1f2a3b4c5d';
const REQUEST = '8a7b6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c5d';
const AUDIT = { userId: 'staff-1', requestId: 'req-1' };

function setup() {
  const reviewPrompts = {
    enable: jest
      .fn()
      .mockResolvedValue({ outcome: 'created', requestId: REQUEST }),
    disable: jest.fn().mockResolvedValue({ outcome: 'disabled' }),
    reset: jest.fn().mockResolvedValue({ outcome: 'reset' }),
    countStoreResults: jest.fn().mockResolvedValue({
      confirmed: 128,
      canceled: 14,
      since: '2026-09-03T08:00:00.000Z',
    }),
    findAdminState: jest.fn().mockResolvedValue({
      orgId: ORG,
      platformType: 'shopify',
      pending: {
        id: REQUEST,
        enabledAt: '2026-10-19T09:00:00.000Z',
        enabledBy: 'staff-1',
      },
      state: {
        state: 'eligible',
        snoozedUntil: null,
        snoozeCount: 0,
        shownCount: 3,
        lastShownAt: '2026-10-19T10:00:00.000Z',
        lastResultCode: null,
        updatedAt: '2026-10-19T10:00:00.000Z',
      },
      events: [
        {
          id: 'e-2',
          requestId: REQUEST,
          event: 'shown',
          actorType: 'merchant',
          actorId: 'shopify-user-1',
          resultCode: null,
          createdAt: '2026-10-19T10:00:00.000Z',
        },
        {
          id: 'e-1',
          requestId: REQUEST,
          event: 'enabled',
          actorType: 'admin',
          actorId: 'staff-1',
          resultCode: null,
          createdAt: '2026-10-19T09:00:00.000Z',
        },
      ],
    }),
  };
  const service = new AdminStoresService(
    {} as never,
    {} as never,
    {} as never,
    undefined,
    undefined,
    reviewPrompts as never,
  );
  return { service, reviewPrompts };
}

describe('AdminStoresService review prompt', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('opens a request with the staff member and returns the view', async () => {
    const { service, reviewPrompts } = setup();

    const result = await service.setReviewPromptEnabled(AUDIT, STORE, true);

    expect(reviewPrompts.enable).toHaveBeenCalledWith(STORE, AUDIT);
    expect(result.review_prompt).toEqual({
      enabled: true,
      request_id: REQUEST,
      enabled_at: '2026-10-19T09:00:00.000Z',
      enabled_by: 'staff-1',
      opted_out: false,
      opted_out_at: null,
      state: 'eligible',
      snoozed_until: null,
      snooze_count: 0,
      shown_count: 3,
      last_shown_at: '2026-10-19T10:00:00.000Z',
      last_result_code: null,
      preview: {
        variant: 'results',
        confirmed: 128,
        canceled: 14,
        since: '2026-09-03T08:00:00.000Z',
      },
      last_event: {
        event: 'shown',
        actor_type: 'merchant',
        at: '2026-10-19T10:00:00.000Z',
      },
      events: [
        {
          id: 'e-2',
          request_id: REQUEST,
          event: 'shown',
          actor_type: 'merchant',
          actor_id: 'shopify-user-1',
          result_code: null,
          at: '2026-10-19T10:00:00.000Z',
        },
        {
          id: 'e-1',
          request_id: REQUEST,
          event: 'enabled',
          actor_type: 'admin',
          actor_id: 'staff-1',
          result_code: null,
          at: '2026-10-19T09:00:00.000Z',
        },
      ],
    });
  });

  it('closes the pending request when switched off', async () => {
    const { service, reviewPrompts } = setup();
    await service.setReviewPromptEnabled(AUDIT, STORE, false);
    expect(reviewPrompts.disable).toHaveBeenCalledWith(STORE, AUDIT);
    expect(reviewPrompts.enable).not.toHaveBeenCalled();
  });

  it.each([
    [true, { outcome: 'already_pending', requestId: REQUEST }],
    [false, { outcome: 'not_pending' }],
  ])(
    'treats a repeated switch (%s) as a no-op success',
    async (enabled, outcome) => {
      const { service, reviewPrompts } = setup();
      reviewPrompts.enable.mockResolvedValue(outcome);
      reviewPrompts.disable.mockResolvedValue(outcome);
      await expect(
        service.setReviewPromptEnabled(AUDIT, STORE, enabled),
      ).resolves.toHaveProperty('review_prompt');
    },
  );

  it('refuses to re-enable a store that opted out', async () => {
    const { service, reviewPrompts } = setup();
    reviewPrompts.enable.mockResolvedValue({ outcome: 'opted_out' });
    await expect(
      service.setReviewPromptEnabled(AUDIT, STORE, true),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: REVIEW_PROMPT_ADMIN_ERROR_CODES.optedOut },
    });
  });

  it('refuses a store that is not on Shopify', async () => {
    const { service, reviewPrompts } = setup();
    reviewPrompts.enable.mockResolvedValue({
      outcome: 'unsupported_platform',
    });
    await expect(
      service.setReviewPromptEnabled(AUDIT, STORE, true),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: REVIEW_PROMPT_ADMIN_ERROR_CODES.unsupportedStore },
    });
  });

  it('reports a missing store as not found', async () => {
    const { service, reviewPrompts } = setup();
    reviewPrompts.enable.mockResolvedValue({ outcome: 'not_found' });
    await expect(
      service.setReviewPromptEnabled(AUDIT, STORE, true),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('shows a declined store as opted out with the switch still on', async () => {
    const { service, reviewPrompts } = setup();
    reviewPrompts.findAdminState.mockResolvedValue({
      orgId: ORG,
      platformType: 'shopify',
      pending: {
        id: REQUEST,
        enabledAt: '2026-10-19T09:00:00.000Z',
        enabledBy: 'staff-1',
      },
      state: {
        state: 'declined',
        snoozedUntil: null,
        snoozeCount: 2,
        shownCount: 2,
        lastShownAt: '2026-10-19T10:00:00.000Z',
        lastResultCode: null,
        updatedAt: '2026-10-19T11:00:00.000Z',
      },
      events: [],
    });
    const { review_prompt } = await service.setReviewPromptEnabled(
      AUDIT,
      STORE,
      true,
    );
    expect(review_prompt).toMatchObject({
      enabled: true,
      opted_out: true,
      opted_out_at: '2026-10-19T11:00:00.000Z',
      state: 'declined',
      snooze_count: 2,
      last_event: null,
    });
  });

  it('reports an expired snooze as eligible', async () => {
    const { service, reviewPrompts } = setup();
    reviewPrompts.findAdminState.mockResolvedValue({
      orgId: ORG,
      platformType: 'shopify',
      pending: null,
      state: {
        state: 'snoozed',
        snoozedUntil: '2020-01-01T00:00:00.000Z',
        snoozeCount: 1,
        shownCount: 1,
        lastShownAt: null,
        lastResultCode: null,
        updatedAt: '2019-12-18T00:00:00.000Z',
      },
      events: [],
    });
    const { review_prompt } = await service.setReviewPromptEnabled(
      AUDIT,
      STORE,
      false,
    );
    expect(review_prompt).toMatchObject({
      state: 'eligible',
      snoozed_until: null,
      snooze_count: 1,
    });
  });

  it('shows the plain variant when the counts fail', async () => {
    const { service, reviewPrompts } = setup();
    reviewPrompts.countStoreResults.mockRejectedValue(new Error('timeout'));
    const { review_prompt } = await service.setReviewPromptEnabled(
      AUDIT,
      STORE,
      true,
    );
    expect(review_prompt?.preview).toEqual({
      variant: 'fallback',
      confirmed: null,
      canceled: null,
      since: null,
    });
  });

  describe('reset', () => {
    it('resets the store with the staff member and returns the view', async () => {
      const { service, reviewPrompts } = setup();
      const result = await service.resetReviewPrompt(AUDIT, STORE);
      expect(reviewPrompts.reset).toHaveBeenCalledWith(STORE, AUDIT);
      expect(result.review_prompt).toMatchObject({ state: 'eligible' });
    });

    it('reports a missing store as not found', async () => {
      const { service, reviewPrompts } = setup();
      reviewPrompts.reset.mockResolvedValue({ outcome: 'not_found' });
      await expect(
        service.resetReviewPrompt(AUDIT, STORE),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses a store that is not on Shopify', async () => {
      const { service, reviewPrompts } = setup();
      reviewPrompts.reset.mockResolvedValue({
        outcome: 'unsupported_platform',
      });
      await expect(
        service.resetReviewPrompt(AUDIT, STORE),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: REVIEW_PROMPT_ADMIN_ERROR_CODES.unsupportedStore },
      });
    });
  });
});
