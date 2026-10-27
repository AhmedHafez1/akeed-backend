import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { TipsService } from './tips.service';

const CAMPAIGN = '11111111-1111-4111-8111-111111111111';

function user(role: AuthenticatedUser['role']): AuthenticatedUser {
  return {
    userId: 'user-1',
    orgId: '22222222-2222-4222-8222-222222222222',
    role,
    source: 'supabase',
  } as AuthenticatedUser;
}

function setup() {
  const repo = {
    findMerchantCards: jest.fn().mockResolvedValue([]),
    findRecipientVisibility: jest.fn().mockResolvedValue({
      status: 'published',
      expiresAt: null,
      actionKind: null,
    }),
    recordEvent: jest.fn().mockResolvedValue(undefined),
  };
  return { repo, service: new TipsService(repo as never) };
}

const en = {
  locale: 'en',
  title: 'Quiet hours',
  description: 'Body',
  action_label: 'Open',
};
const ar = {
  locale: 'ar',
  title: 'ساعات الهدوء',
  description: 'نص',
  action_label: 'افتح',
};

describe('TipsService', () => {
  it('reads cards for the authenticated organization in its locale', async () => {
    const { service, repo } = setup();
    repo.findMerchantCards.mockResolvedValue([
      {
        id: CAMPAIGN,
        type: 'tip',
        action_kind: 'internal',
        action_route: 'settings_timing',
        action_url: null,
        first_viewed_at: null,
        published_at: '2026-10-25T10:00:00.000Z',
        translations: [en, ar],
      },
    ]);
    const result = await service.getCards(user('owner'), 'ar');
    expect(repo.findMerchantCards).toHaveBeenCalledWith(
      user('owner').orgId,
      'ar',
      20,
    );
    expect(result).toEqual({
      can_dismiss: true,
      cards: [
        {
          id: CAMPAIGN,
          type: 'tip',
          locale: 'ar',
          title: 'ساعات الهدوء',
          description: 'نص',
          action: { kind: 'internal', route: 'settings_timing', label: 'افتح' },
          first_viewed_at: null,
          published_at: '2026-10-25T10:00:00.000Z',
        },
      ],
    });
  });

  it('returns existing store-wide read history to viewers', async () => {
    const { service, repo } = setup();
    const firstViewedAt = '2026-10-26T10:00:00.000Z';
    repo.findMerchantCards.mockResolvedValue([
      {
        id: CAMPAIGN,
        type: 'tip',
        action_kind: null,
        first_viewed_at: firstViewedAt,
        published_at: '2026-10-25T10:00:00.000Z',
        translations: [en],
      },
    ]);
    const result = await service.getCards(user('viewer'), 'en');
    expect(result.cards[0].first_viewed_at).toBe(firstViewedAt);
    expect(result.can_dismiss).toBe(false);
  });

  it('falls back to the whole English bundle and drops an unknown route', async () => {
    const { service, repo } = setup();
    repo.findMerchantCards.mockResolvedValue([
      {
        id: CAMPAIGN,
        type: 'update',
        action_kind: 'internal',
        action_route: 'removed_page',
        action_url: null,
        first_viewed_at: null,
        published_at: '2026-10-25T10:00:00.000Z',
        translations: [en, { ...ar, action_label: null }],
      },
    ]);
    const [card] = (await service.getCards(user('viewer'), 'ar')).cards;
    expect(card.locale).toBe('en');
    expect(card.title).toBe('Quiet hours');
    expect(card.action).toBeNull();
  });

  it('tells viewers they cannot dismiss, and refuses their dismissal', async () => {
    const { service, repo } = setup();
    expect((await service.getCards(user('viewer'))).can_dismiss).toBe(false);
    await expect(
      service.recordEvent(user('viewer'), CAMPAIGN, 'dismiss'),
    ).rejects.toMatchObject({
      response: { code: 'TIPS_DISMISS_FORBIDDEN' },
    });
    expect(repo.recordEvent).not.toHaveBeenCalled();
  });

  it("counts a viewer's views and clicks", async () => {
    const { service, repo } = setup();
    await service.recordEvent(user('viewer'), CAMPAIGN, 'view');
    await service.recordEvent(user('viewer'), CAMPAIGN, 'click');
    expect(repo.recordEvent).toHaveBeenCalledTimes(2);
  });

  it("hides another organization's campaign as not found", async () => {
    const { service, repo } = setup();
    repo.findRecipientVisibility.mockResolvedValue(null);
    await expect(
      service.recordEvent(user('owner'), CAMPAIGN, 'dismiss'),
    ).rejects.toMatchObject({
      response: { code: 'TIPS_CARD_NOT_FOUND' },
    });
    expect(repo.findRecipientVisibility).toHaveBeenCalledWith(
      CAMPAIGN,
      user('owner').orgId,
    );
    expect(repo.recordEvent).not.toHaveBeenCalled();
  });

  it("records a dismissal on the organization's own row", async () => {
    const { service, repo } = setup();
    await service.recordEvent(user('admin'), CAMPAIGN, 'dismiss');
    expect(repo.recordEvent).toHaveBeenCalledWith(
      CAMPAIGN,
      user('admin').orgId,
      'dismiss',
    );
  });
});
