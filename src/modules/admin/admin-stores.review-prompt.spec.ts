import { Logger, NotFoundException } from '@nestjs/common';
import {
  AdminStoresService,
  REVIEW_PROMPT_ADMIN_ERROR_CODES,
} from './admin-stores.service';

const STORE = '3f2b1c4d-5e6f-4a1b-8c9d-0e1f2a3b4c5d';
const REQUEST = '8a7b6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c5d';
const AUDIT = { userId: 'staff-1', requestId: 'req-1' };

function setup() {
  const reviewPrompts = {
    enable: jest
      .fn()
      .mockResolvedValue({ outcome: 'created', requestId: REQUEST }),
    disable: jest.fn().mockResolvedValue({ outcome: 'disabled' }),
    findAdminState: jest.fn().mockResolvedValue({
      platformType: 'shopify',
      pending: {
        id: REQUEST,
        enabledAt: '2026-10-19T09:00:00.000Z',
        enabledBy: 'staff-1',
      },
      optedOutAt: null,
      events: [
        {
          id: 'e-2',
          requestId: REQUEST,
          event: 'shown',
          actorType: 'merchant',
          actorId: 'shopify-user-1',
          createdAt: '2026-10-19T10:00:00.000Z',
        },
        {
          id: 'e-1',
          requestId: REQUEST,
          event: 'enabled',
          actorType: 'admin',
          actorId: 'staff-1',
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
          at: '2026-10-19T10:00:00.000Z',
        },
        {
          id: 'e-1',
          request_id: REQUEST,
          event: 'enabled',
          actor_type: 'admin',
          actor_id: 'staff-1',
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

  it('shows the opt-out and no switch-on after "Don\'t ask again"', async () => {
    const { service, reviewPrompts } = setup();
    reviewPrompts.disable.mockResolvedValue({ outcome: 'not_pending' });
    reviewPrompts.findAdminState.mockResolvedValue({
      platformType: 'shopify',
      pending: null,
      optedOutAt: '2026-10-19T11:00:00.000Z',
      events: [],
    });
    const { review_prompt } = await service.setReviewPromptEnabled(
      AUDIT,
      STORE,
      false,
    );
    expect(review_prompt).toMatchObject({
      enabled: false,
      opted_out: true,
      opted_out_at: '2026-10-19T11:00:00.000Z',
      last_event: null,
    });
  });
});
