/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import type {
  TipsCampaignDetail,
  TipsCampaignRecord,
} from '../../infrastructure/database/repositories/tips-campaigns.repository';
import { AdminTipsCampaignsService } from './admin-tips-campaigns.service';

const NOW = new Date('2026-10-25T12:00:00.000Z');
const ID = '11111111-1111-4111-8111-111111111111';
const AUDIT = {
  userId: '6f1b6c1e-2d4a-4c3b-9a8e-1f2e3d4c5b6a',
  requestId: 'req-1',
};
const HASH = 'b'.repeat(64);

function record(
  overrides: Partial<TipsCampaignRecord> = {},
): TipsCampaignRecord {
  return {
    id: ID,
    name: 'Quiet hours tip',
    type: 'tip',
    status: 'draft',
    actionKind: null,
    actionRoute: null,
    actionUrl: null,
    expiresAt: null,
    targetingMode: 'filters',
    audienceFilters: { countries: ['PK'] },
    selectedOrgIds: [],
    excludedOrgIds: [],
    revision: 3,
    reviewedRevision: 3,
    reviewedAudienceHash: HASH,
    reviewedRecipientCount: 2,
    reviewedAt: '2026-10-25 11:00:00+00',
    reviewedBy: AUDIT.userId,
    publishedAt: null,
    publishedBy: null,
    publishedReviewToken: null,
    recipientCount: null,
    pausedAt: null,
    archivedAt: null,
    createdBy: AUDIT.userId,
    updatedBy: AUDIT.userId,
    createdAt: '2026-10-20 10:00:00+00',
    updatedAt: '2026-10-25 11:00:00+00',
    ...overrides,
  };
}

function detail(
  overrides: Partial<TipsCampaignRecord> = {},
): TipsCampaignDetail {
  return {
    campaign: record(overrides),
    translations: [
      {
        campaignId: ID,
        locale: 'en',
        title: 'Quiet hours',
        description: 'Hold messages at night.',
        actionLabel: null,
        createdAt: '2026-10-20 10:00:00+00',
        updatedAt: '2026-10-20 10:00:00+00',
      },
    ],
  };
}

function setup(current: TipsCampaignDetail = detail()) {
  const repo = {
    findById: jest.fn().mockResolvedValue(current),
    analytics: jest.fn().mockResolvedValue({
      recipients: 0,
      viewed: 0,
      clicked: 0,
      dismissed: 0,
    }),
    audienceFromRecord: jest.fn((campaign: TipsCampaignRecord) => ({
      mode: campaign.targetingMode,
      filters: campaign.audienceFilters,
      selectedOrgIds: campaign.selectedOrgIds,
      excludedOrgIds: campaign.excludedOrgIds,
    })),
    summarizeAudience: jest.fn().mockResolvedValue({ count: 2, hash: HASH }),
    saveReview: jest.fn().mockResolvedValue(true),
    publish: jest.fn(),
    update: jest
      .fn()
      .mockResolvedValue({ kind: 'updated', campaign: current.campaign }),
    create: jest.fn().mockResolvedValue(current.campaign),
    transition: jest
      .fn()
      .mockResolvedValue({ kind: 'updated', campaign: current.campaign }),
  };
  class FixedClockService extends AdminTipsCampaignsService {
    protected override now(): Date {
      return NOW;
    }
  }
  return { repo, service: new FixedClockService(repo as never) };
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return (error as { getResponse(): Record<string, unknown> }).getResponse();
  }
  throw new Error('expected a rejection');
}

describe('AdminTipsCampaignsService', () => {
  describe('review', () => {
    it('records the audience and returns a token for the current revision', async () => {
      const { service, repo } = setup();
      const result = await service.review(AUDIT, ID);
      expect(repo.saveReview).toHaveBeenCalledWith(
        ID,
        3,
        { count: 2, hash: HASH },
        AUDIT.userId,
      );
      expect(result.review_token).toBe(`3.${HASH}`);
      expect(result.recipient_count).toBe(2);
    });

    it('rejects an empty audience and an oversized one', async () => {
      const empty = setup();
      empty.repo.summarizeAudience.mockResolvedValue({ count: 0, hash: HASH });
      expect((await rejection(empty.service.review(AUDIT, ID))).code).toBe(
        'TIPS_CAMPAIGN_NO_RECIPIENTS',
      );
      const large = setup();
      large.repo.summarizeAudience.mockResolvedValue({
        count: 50_001,
        hash: HASH,
      });
      expect(await rejection(large.service.review(AUDIT, ID))).toMatchObject({
        code: 'TIPS_CAMPAIGN_AUDIENCE_TOO_LARGE',
        recipient_count: 50_001,
      });
    });

    it('rejects invalid content and a past expiry before counting', async () => {
      const { service, repo } = setup(
        detail({ expiresAt: '2026-10-01 00:00:00+00' }),
      );
      expect(await rejection(service.review(AUDIT, ID))).toMatchObject({
        code: 'TIPS_CAMPAIGN_INVALID',
        issues: [{ field: 'expires_at', code: 'expiry_in_past' }],
      });
      expect(repo.summarizeAudience).not.toHaveBeenCalled();
    });

    it('refuses to review a published campaign', async () => {
      const { service } = setup(
        detail({
          status: 'published',
          publishedAt: '2026-10-24 00:00:00+00',
          recipientCount: 2,
        }),
      );
      expect((await rejection(service.review(AUDIT, ID))).code).toBe(
        'TIPS_CAMPAIGN_INVALID_TRANSITION',
      );
    });
  });

  describe('publish', () => {
    it('requires the token of the stored review', async () => {
      const { service, repo } = setup();
      for (const token of ['nonsense', `2.${HASH}`, `3.${'c'.repeat(64)}`]) {
        expect((await rejection(service.publish(AUDIT, ID, token))).code).toBe(
          'TIPS_CAMPAIGN_REVIEW_REQUIRED',
        );
      }
      expect(repo.publish).not.toHaveBeenCalled();
    });

    it('publishes with the reviewed hash and revision', async () => {
      const { service, repo } = setup();
      repo.publish.mockResolvedValue({ kind: 'published', campaign: record() });
      const view = await service.publish(AUDIT, ID, `3.${HASH}`);
      expect(repo.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          id: ID,
          revision: 3,
          reviewedHash: HASH,
          token: `3.${HASH}`,
          maxRecipients: 50_000,
        }),
      );
      expect(view.already_published).toBe(false);
    });

    it('replays a retry of an already published campaign', async () => {
      const published = detail({
        status: 'published',
        publishedAt: '2026-10-25 11:30:00+00',
        recipientCount: 2,
        publishedReviewToken: `3.${HASH}`,
      });
      const { service, repo } = setup(published);
      repo.publish.mockResolvedValue({
        kind: 'already_published',
        campaign: published.campaign,
      });
      expect(
        (await service.publish(AUDIT, ID, `3.${HASH}`)).already_published,
      ).toBe(true);
    });

    it.each([
      [
        { kind: 'audience_changed', count: 4 },
        'TIPS_CAMPAIGN_AUDIENCE_CHANGED',
      ],
      [{ kind: 'no_recipients' }, 'TIPS_CAMPAIGN_NO_RECIPIENTS'],
      [
        { kind: 'too_large', count: 60_000 },
        'TIPS_CAMPAIGN_AUDIENCE_TOO_LARGE',
      ],
      [{ kind: 'revision_mismatch' }, 'TIPS_CAMPAIGN_REVIEW_REQUIRED'],
      [
        { kind: 'not_draft', status: 'archived' },
        'TIPS_CAMPAIGN_INVALID_TRANSITION',
      ],
      [{ kind: 'expired' }, 'TIPS_CAMPAIGN_INVALID'],
      [{ kind: 'not_found' }, 'TIPS_CAMPAIGN_NOT_FOUND'],
    ])('maps %j to %s', async (outcome, code) => {
      const { service, repo } = setup();
      repo.publish.mockResolvedValue(outcome);
      expect(
        (await rejection(service.publish(AUDIT, ID, `3.${HASH}`))).code,
      ).toBe(code);
    });
  });

  describe('update', () => {
    const published = () =>
      detail({
        status: 'published',
        publishedAt: '2026-10-24 00:00:00+00',
        recipientCount: 2,
        expiresAt: '2026-12-01 00:00:00+00',
      });

    it('locks the audience and expiry of a published campaign', async () => {
      const { service, repo } = setup(published());
      expect(
        (
          await rejection(
            service.update(AUDIT, ID, {
              revision: 3,
              audience: { mode: 'filters', filters: { countries: ['EG'] } },
            }),
          )
        ).code,
      ).toBe('TIPS_CAMPAIGN_AUDIENCE_LOCKED');
      expect(
        (
          await rejection(
            service.update(AUDIT, ID, {
              revision: 3,
              expires_at: '2027-01-01T00:00:00.000Z',
            }),
          )
        ).code,
      ).toBe('TIPS_CAMPAIGN_EXPIRY_LOCKED');
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('accepts the unchanged audience and expiry sent back with a content edit', async () => {
      const { service, repo } = setup(published());
      await service.update(AUDIT, ID, {
        revision: 3,
        audience: { mode: 'filters', filters: { countries: ['pk'] } },
        expires_at: '2026-12-01T00:00:00.000Z',
        translations: [
          { locale: 'en', title: 'New title', description: 'New body.' },
        ],
      });
      const patch = repo.update.mock.calls[0][2];
      expect(patch.audience).toBeUndefined();
      expect(patch.expiresAt).toBeUndefined();
      expect(patch.translations[0].title).toBe('New title');
    });

    it('refuses archived campaigns and stale revisions', async () => {
      const archived = setup(
        detail({ status: 'archived', archivedAt: '2026-10-24 00:00:00+00' }),
      );
      expect(
        (
          await rejection(
            archived.service.update(AUDIT, ID, { revision: 3, name: 'x' }),
          )
        ).code,
      ).toBe('TIPS_CAMPAIGN_NOT_EDITABLE');
      const stale = setup();
      stale.repo.update.mockResolvedValue({ kind: 'revision_conflict' });
      expect(
        (
          await rejection(
            stale.service.update(AUDIT, ID, { revision: 2, name: 'Renamed' }),
          )
        ).code,
      ).toBe('TIPS_CAMPAIGN_REVISION_CONFLICT');
    });

    it('answers invalid content with coded field issues', async () => {
      const { service } = setup();
      expect(
        await rejection(
          service.update(AUDIT, ID, {
            revision: 3,
            translations: [{ locale: 'en', title: '', description: 'Body' }],
            action: { kind: 'external', url: 'javascript:alert(1)' },
          }),
        ),
      ).toMatchObject({
        code: 'TIPS_CAMPAIGN_INVALID',
        issues: expect.arrayContaining([
          { field: 'action.url', code: 'url_not_https' },
          { field: 'title', code: 'required', locale: 'en' },
        ]),
      });
    });
  });

  describe('create', () => {
    it('validates and normalizes before writing', async () => {
      const { service, repo } = setup();
      await service.create(AUDIT, {
        name: '  New tip ',
        type: 'update',
        translations: [
          { locale: 'en', title: 'T', description: 'D', action_label: 'Open' },
        ],
        action: { kind: 'internal', route: 'settings_timing' },
        audience: {
          mode: 'direct',
          selected_org_ids: ['22222222-2222-4222-8222-222222222222'],
        },
        expires_at: '2026-11-01T00:00:00Z',
      });
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'New tip',
          action: { kind: 'internal', route: 'settings_timing' },
          expiresAt: '2026-11-01T00:00:00.000Z',
          audience: expect.objectContaining({
            mode: 'direct',
            selectedOrgIds: ['22222222-2222-4222-8222-222222222222'],
          }),
        }),
        AUDIT,
      );
    });

    it('rejects a past expiry', async () => {
      const { service, repo } = setup();
      expect(
        await rejection(
          service.create(AUDIT, {
            name: 'Tip',
            type: 'tip',
            translations: [{ locale: 'en', title: 'T', description: 'D' }],
            expires_at: '2026-10-01T00:00:00Z',
          }),
        ),
      ).toMatchObject({
        issues: [{ field: 'expires_at', code: 'expiry_in_past' }],
      });
      expect(repo.create).not.toHaveBeenCalled();
    });
  });

  describe('lifecycle', () => {
    it('does not resume an expired campaign', async () => {
      const { service, repo } = setup(
        detail({
          status: 'paused',
          publishedAt: '2026-10-01 00:00:00+00',
          recipientCount: 2,
          expiresAt: '2026-10-20 00:00:00+00',
        }),
      );
      expect(
        (await rejection(service.changeLifecycle(AUDIT, ID, 'resume'))).code,
      ).toBe('TIPS_CAMPAIGN_EXPIRED');
      expect(repo.transition).not.toHaveBeenCalled();
    });

    it('treats a repeated pause as done and reports a concurrent change', async () => {
      const paused = setup(
        detail({
          status: 'paused',
          publishedAt: '2026-10-01 00:00:00+00',
          recipientCount: 2,
        }),
      );
      await paused.service.changeLifecycle(AUDIT, ID, 'pause');
      expect(paused.repo.transition).not.toHaveBeenCalled();

      const raced = setup(
        detail({
          status: 'published',
          publishedAt: '2026-10-01 00:00:00+00',
          recipientCount: 2,
        }),
      );
      raced.repo.transition.mockResolvedValue({ kind: 'state_changed' });
      expect(
        (await rejection(raced.service.changeLifecycle(AUDIT, ID, 'pause')))
          .code,
      ).toBe('TIPS_CAMPAIGN_REVISION_CONFLICT');
    });
  });
});
