/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../src/infrastructure/database';
import {
  TipsCampaignsRepository,
  type TipsCampaignRecord,
} from '../src/infrastructure/database/repositories/tips-campaigns.repository';
import { buildTipsReviewToken } from '../src/shared/tips-campaigns/tips-campaign.policy';
import type {
  TipsAudience,
  TipsAudienceFilters,
  TipsCampaignAction,
} from '../src/shared/tips-campaigns/tips-campaign.types';

function isolatedDatabaseUrl(): string {
  const value = process.env.E01_TEST_DATABASE_URL;
  if (!value)
    throw new Error(
      'NOT RUN: E01_TEST_DATABASE_URL is required; application DATABASE_URL is never used.',
    );
  const url = new URL(value);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/akeed_e01_test' ||
    url.username !== 'e01_test' ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'NOT RUN: use local PostgreSQL, user e01_test, database akeed_e01_test, without query parameters.',
    );
  }
  return value;
}

const MIGRATION = '0077_tips_campaigns.sql';
const namespace = `tips_campaigns_${randomUUID().replaceAll('-', '')}`;
const client = postgres(isolatedDatabaseUrl(), {
  max: 6,
  connect_timeout: 5,
  onnotice: () => undefined,
  connection: { search_path: `${namespace},public` },
});
const repository = new TipsCampaignsRepository(
  drizzle(client, { schema }) as never,
);
const STAFF = '6f1b6c1e-2d4a-4c3b-9a8e-1f2e3d4c5b6a';
const AUDIT = { userId: STAFF, requestId: 'req-contract' };
const MAX = 50_000;
let created = false;

async function migrate(file: string): Promise<void> {
  await client.begin(async (tx) => {
    for (const statement of readFileSync(
      resolve(__dirname, '../drizzle', file),
      'utf8',
    ).split('--> statement-breakpoint')) {
      if (statement.trim()) await tx.unsafe(statement);
    }
  });
}

interface StoreSpec {
  platform?: string;
  country?: string | null;
  language?: string;
  plan?: string;
  billingStatus?: string | null;
  createdAt?: string | null;
  active?: boolean;
  autoCancel?: boolean;
  quietHours?: boolean;
  autoVerify?: boolean | null;
  name?: string;
}

/** An organization with one store; returns the organization id. */
async function merchant(spec: StoreSpec = {}): Promise<string> {
  const orgId = randomUUID();
  await client`
    INSERT INTO organizations (id, name, created_at)
    VALUES (${orgId}, ${spec.name ?? `Org ${orgId.slice(0, 6)}`}, ${spec.createdAt === undefined ? '2026-01-01T00:00:00Z' : spec.createdAt})`;
  await store(orgId, spec);
  return orgId;
}

async function store(orgId: string, spec: StoreSpec): Promise<void> {
  const platform = spec.platform ?? 'shopify';
  await client`
    INSERT INTO integrations (
      id, org_id, platform_type, platform_store_url, store_name, is_active, country_code,
      default_language, billing_plan_id, billing_status, auto_cancel_enabled,
      quiet_hours_enabled, is_auto_verify_enabled
    ) VALUES (
      ${randomUUID()}, ${orgId}, ${platform}, ${`${orgId}.example.com`}, ${spec.name ?? null},
      ${spec.active ?? true}, ${spec.country === undefined ? null : spec.country},
      ${spec.language ?? 'en'}, ${spec.plan ?? 'starter'},
      ${spec.billingStatus === undefined ? (platform === 'shopify' ? 'active' : 'not_required') : spec.billingStatus},
      ${spec.autoCancel ?? false}, ${spec.quietHours ?? false},
      ${spec.autoVerify === undefined ? true : spec.autoVerify}
    )`;
}

function filters(
  value: TipsAudienceFilters,
  excluded: string[] = [],
): TipsAudience {
  return {
    mode: 'filters',
    filters: value,
    selectedOrgIds: [],
    excludedOrgIds: excluded,
  };
}

function direct(ids: string[]): TipsAudience {
  return {
    mode: 'direct',
    filters: {},
    selectedOrgIds: [...ids].sort(),
    excludedOrgIds: [],
  };
}

async function matches(audience: TipsAudience): Promise<string[]> {
  const page = await repository.pageAudience(audience, { limit: 500 }, false);
  return page.map((row) => row.org_id).sort();
}

async function draft(
  audience: TipsAudience,
  options: {
    action?: TipsCampaignAction | null;
    name?: string;
    expiresAt?: string | null;
  } = {},
): Promise<TipsCampaignRecord> {
  const action = options.action ?? null;
  return repository.create(
    {
      name: options.name ?? 'Contract campaign',
      type: 'tip',
      action,
      expiresAt: options.expiresAt ?? null,
      audience,
      translations: [
        {
          locale: 'en',
          title: 'Quiet hours',
          description: 'Hold messages at night.',
          action_label: action ? 'Open settings' : null,
        },
        {
          locale: 'ar',
          title: 'ساعات الهدوء',
          description: 'أوقف الرسائل بالليل.',
          action_label: action ? 'افتح الإعدادات' : null,
        },
      ],
    },
    AUDIT,
  );
}

async function reviewAndPublish(campaign: TipsCampaignRecord) {
  const summary = await repository.summarizeAudience(
    repository.audienceFromRecord(campaign),
  );
  return repository.publish({
    id: campaign.id,
    revision: campaign.revision,
    reviewedHash: summary.hash,
    token: buildTipsReviewToken(campaign.revision, summary.hash),
    maxRecipients: MAX,
    audit: AUDIT,
  });
}

async function recipientIds(campaignId: string): Promise<string[]> {
  const rows = await client<{ org_id: string }[]>`
    SELECT org_id FROM tips_campaign_recipients WHERE campaign_id = ${campaignId} ORDER BY org_id`;
  return rows.map((row) => row.org_id);
}

async function cardIds(orgId: string, locale: 'en' | 'ar' | 'fr' = 'en') {
  const cards = await repository.findMerchantCards(orgId, locale, 20);
  return cards.map((card) => card.id);
}

describe('tips campaigns (Postgres contract)', () => {
  const base: Record<string, string> = {};

  beforeAll(async () => {
    await client`CREATE SCHEMA ${client(namespace)}`;
    created = true;
    await client.unsafe(`
      DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      CREATE TABLE organizations (
        id uuid PRIMARY KEY,
        name text NOT NULL,
        created_at timestamptz
      );
      CREATE TABLE integrations (
        id uuid PRIMARY KEY,
        org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        platform_type text NOT NULL,
        platform_store_url text NOT NULL,
        store_name text,
        is_active boolean DEFAULT true,
        country_code varchar(2),
        default_language text DEFAULT 'auto' NOT NULL,
        billing_plan_id text DEFAULT 'starter' NOT NULL,
        billing_status text,
        auto_cancel_enabled boolean DEFAULT false NOT NULL,
        quiet_hours_enabled boolean DEFAULT false NOT NULL,
        follow_up_enabled boolean DEFAULT true NOT NULL,
        escalation_enabled boolean DEFAULT true NOT NULL,
        is_auto_verify_enabled boolean DEFAULT true,
        logo_header_enabled boolean DEFAULT true NOT NULL,
        created_at timestamptz DEFAULT now() NOT NULL
      );
      CREATE UNIQUE INDEX integrations_one_active_source_per_org_idx
        ON integrations (org_id) WHERE is_active = true;
      CREATE TABLE admin_access_audit (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid,
        action text NOT NULL,
        outcome text NOT NULL,
        request_id text,
        target_integration_id uuid,
        metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
        created_at timestamptz DEFAULT now()
      );
    `);
    await migrate(MIGRATION);
    // Applying it again proves it re-runs cleanly.
    await migrate(MIGRATION);

    base.egyptStarter = await merchant({
      country: 'EG',
      language: 'ar',
      plan: 'starter',
      billingStatus: 'not_required',
      autoCancel: true,
      createdAt: '2026-01-10T08:00:00Z',
      name: 'Cairo Shop',
    });
    base.pakistanPro = await merchant({
      country: 'PK',
      language: 'en',
      plan: 'pro',
      billingStatus: 'active',
      createdAt: '2026-02-01T00:00:00Z',
      name: 'Lahore Store',
    });
    // An old, inactive store of the same organization must not duplicate it.
    await store(base.pakistanPro, { country: 'PK', active: false });
    base.standalone = await merchant({
      platform: 'standalone',
      language: 'ur',
      quietHours: true,
      createdAt: '2026-02-15T23:30:00Z',
    });
    base.woo = await merchant({
      platform: 'woocommerce',
      language: 'auto',
      createdAt: null,
      autoVerify: null,
    });
    base.easy = await merchant({
      platform: 'easyorders',
      language: 'en',
      createdAt: '2026-03-01T00:00:00Z',
    });
    // A Shopify store whose subscription is not current has no known plan.
    base.frozenPro = await merchant({
      country: 'PK',
      language: 'en',
      plan: 'pro',
      billingStatus: 'frozen',
      createdAt: '2026-02-05T00:00:00Z',
    });
    // An organization whose only store is uninstalled is never a recipient.
    base.uninstalled = await merchant({ country: 'PK', active: false });
  });

  afterAll(async () => {
    try {
      if (created) await client`DROP SCHEMA ${client(namespace)} CASCADE`;
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  describe('audience filters', () => {
    it('matches country only where it is known, never an uninstalled store', async () => {
      expect(await matches(filters({ countries: ['PK'] }))).toEqual(
        [base.pakistanPro, base.frozenPro].sort(),
      );
    });

    it('ORs values inside one filter', async () => {
      expect(
        await matches(filters({ platforms: ['standalone', 'woocommerce'] })),
      ).toEqual([base.standalone, base.woo].sort());
    });

    it('ANDs different filters', async () => {
      expect(
        await matches(
          filters({
            countries: ['PK'],
            message_languages: ['en'],
            plans: ['pro'],
          }),
        ),
      ).toEqual([base.pakistanPro]);
      expect(
        await matches(
          filters({ countries: ['PK'], features: { auto_cancel: true } }),
        ),
      ).toEqual([]);
    });

    it('reads plans from current Shopify billing and prepaid platforms', async () => {
      expect(await matches(filters({ plans: ['starter'] }))).toEqual([
        base.egyptStarter,
      ]);
      expect(await matches(filters({ plans: ['prepaid'] }))).toEqual(
        [base.standalone, base.woo, base.easy].sort(),
      );
      expect(await matches(filters({ plans: ['pro'] }))).toEqual([
        base.pakistanPro,
      ]);
    });

    it('treats signup dates as inclusive whole UTC days and skips unknown dates', async () => {
      expect(
        await matches(
          filters({ signup_from: '2026-02-01', signup_to: '2026-02-15' }),
        ),
      ).toEqual([base.pakistanPro, base.standalone, base.frozenPro].sort());
      const before = await matches(filters({ signup_to: '2026-01-31' }));
      expect(before).toContain(base.egyptStarter);
      expect(before).not.toContain(base.woo);
    });

    it('matches feature states and never treats a missing value as disabled', async () => {
      expect(
        await matches(filters({ features: { quiet_hours: true } })),
      ).toEqual([base.standalone]);
      const notAutoVerify = await matches(
        filters({ features: { auto_verify: false } }),
      );
      expect(notAutoVerify).not.toContain(base.woo);
    });

    it('drops exclusions, and lists them flagged when asked', async () => {
      const audience = filters({ countries: ['EG', 'PK'] }, [base.frozenPro]);
      expect(await matches(audience)).toEqual(
        [base.egyptStarter, base.pakistanPro].sort(),
      );
      const marked = await repository.pageAudience(
        audience,
        { limit: 50 },
        true,
      );
      expect(
        marked.find((row) => row.org_id === base.frozenPro)?.excluded,
      ).toBe(true);
    });

    it('selects directly, skipping organizations without an active store', async () => {
      expect(
        await matches(
          direct([base.egyptStarter, base.uninstalled, randomUUID()]),
        ),
      ).toEqual([base.egyptStarter]);
    });

    it('counts an organization once and hashes the sorted ids', async () => {
      const audience = filters({ countries: ['PK'] });
      const first = await repository.summarizeAudience(audience);
      expect(first.count).toBe(2);
      expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(await repository.summarizeAudience(audience)).toEqual(first);
    });

    it('searches the organization picker by store or organization name', async () => {
      const rows = await repository.searchOrganizations({
        search: 'lahore',
        limit: 10,
      });
      expect(rows.map((row) => row.org_id)).toEqual([base.pakistanPro]);
      const escaped = await repository.searchOrganizations({
        search: '%',
        limit: 10,
      });
      expect(escaped).toEqual([]);
    });
  });

  describe('publication', () => {
    it('freezes the reviewed recipients and replays a retry', async () => {
      const first = await merchant({ country: 'NZ' });
      const second = await merchant({ country: 'NZ' });
      const campaign = await draft(filters({ countries: ['NZ'] }));
      const summary = await repository.summarizeAudience(
        repository.audienceFromRecord(campaign),
      );
      const token = buildTipsReviewToken(campaign.revision, summary.hash);
      const params = {
        id: campaign.id,
        revision: campaign.revision,
        reviewedHash: summary.hash,
        token,
        maxRecipients: MAX,
        audit: AUDIT,
      };

      const published = await repository.publish(params);
      expect(published.kind).toBe('published');
      expect(await recipientIds(campaign.id)).toEqual([first, second].sort());

      const retry = await repository.publish(params);
      expect(retry.kind).toBe('already_published');
      expect(await recipientIds(campaign.id)).toEqual([first, second].sort());

      // A new matching merchant is never added, and a recipient whose
      // settings change stays a recipient.
      await merchant({ country: 'NZ' });
      await client`UPDATE integrations SET country_code = 'GB' WHERE org_id = ${first}`;
      expect(await recipientIds(campaign.id)).toEqual([first, second].sort());
      expect(await cardIds(first)).toContain(campaign.id);
    });

    it('rolls back when the audience changed since review', async () => {
      await merchant({ country: 'AU' });
      const campaign = await draft(filters({ countries: ['AU'] }));
      const summary = await repository.summarizeAudience(
        repository.audienceFromRecord(campaign),
      );
      await merchant({ country: 'AU' });
      const outcome = await repository.publish({
        id: campaign.id,
        revision: campaign.revision,
        reviewedHash: summary.hash,
        token: buildTipsReviewToken(campaign.revision, summary.hash),
        maxRecipients: MAX,
        audit: AUDIT,
      });
      expect(outcome).toEqual({ kind: 'audience_changed', count: 2 });
      expect(await recipientIds(campaign.id)).toEqual([]);
      expect((await repository.findById(campaign.id))?.campaign.status).toBe(
        'draft',
      );
    });

    it('rejects a stale revision, an empty audience, a past expiry and an oversized one', async () => {
      const campaign = await draft(filters({ countries: ['AU'] }));
      const summary = await repository.summarizeAudience(
        repository.audienceFromRecord(campaign),
      );
      const stale = await repository.publish({
        id: campaign.id,
        revision: campaign.revision + 1,
        reviewedHash: summary.hash,
        token: buildTipsReviewToken(campaign.revision + 1, summary.hash),
        maxRecipients: MAX,
        audit: AUDIT,
      });
      expect(stale.kind).toBe('revision_mismatch');

      const tooLarge = await repository.publish({
        id: campaign.id,
        revision: campaign.revision,
        reviewedHash: summary.hash,
        token: buildTipsReviewToken(campaign.revision, summary.hash),
        maxRecipients: 1,
        audit: AUDIT,
      });
      expect(tooLarge).toEqual({ kind: 'too_large', count: 2 });
      expect(await recipientIds(campaign.id)).toEqual([]);

      expect(
        (await reviewAndPublish(await draft(filters({ countries: ['QQ'] }))))
          .kind,
      ).toBe('no_recipients');

      const expiring = await draft(filters({ countries: ['AU'] }));
      await client`UPDATE tips_campaigns SET expires_at = now() - interval '1 minute' WHERE id = ${expiring.id}`;
      expect((await reviewAndPublish(expiring)).kind).toBe('expired');
    });

    it('never leaves a partial snapshot when publication fails', async () => {
      await client.unsafe(`
        CREATE FUNCTION ${namespace}.refuse_publish() RETURNS trigger AS $$
        BEGIN
          IF NEW.name = 'fail on publish' AND NEW.status = 'published' THEN
            RAISE EXCEPTION 'simulated publish failure';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql;
        CREATE TRIGGER refuse_publish BEFORE UPDATE ON ${namespace}.tips_campaigns
          FOR EACH ROW EXECUTE FUNCTION ${namespace}.refuse_publish();
      `);
      const campaign = await draft(filters({ countries: ['AU'] }), {
        name: 'fail on publish',
      });
      await expect(reviewAndPublish(campaign)).rejects.toThrow();
      expect(await recipientIds(campaign.id)).toEqual([]);
      expect((await repository.findById(campaign.id))?.campaign.status).toBe(
        'draft',
      );
    });

    it('audits each admin write', async () => {
      const rows = await client<{ action: string }[]>`
        SELECT DISTINCT action FROM admin_access_audit ORDER BY action`;
      expect(rows.map((row) => row.action)).toEqual(
        expect.arrayContaining([
          'tips-campaign.create',
          'tips-campaign.publish',
        ]),
      );
    });
  });

  describe('merchant visibility and analytics', () => {
    let alpha: string;
    let beta: string;
    let outsider: string;

    beforeAll(async () => {
      alpha = await merchant({ country: 'CA' });
      beta = await merchant({ country: 'CA' });
      outsider = await merchant({ country: 'CL' });
    });

    it("shows every active card newest first, never another merchant's", async () => {
      const older = await draft(direct([alpha, beta]));
      const newer = await draft(direct([alpha]));
      expect((await reviewAndPublish(older)).kind).toBe('published');
      expect((await reviewAndPublish(newer)).kind).toBe('published');
      await client`UPDATE tips_campaigns SET published_at = '2026-10-01T00:00:00Z' WHERE id = ${older.id}`;
      await client`UPDATE tips_campaigns SET published_at = '2026-10-02T00:00:00Z' WHERE id = ${newer.id}`;

      const alphaCards = await cardIds(alpha);
      expect(alphaCards.indexOf(newer.id)).toBeLessThan(
        alphaCards.indexOf(older.id),
      );
      expect(await cardIds(beta)).toContain(older.id);
      expect(await cardIds(beta)).not.toContain(newer.id);
      expect(await cardIds(outsider)).toEqual([]);
      expect(
        await repository.findRecipientVisibility(newer.id, outsider),
      ).toBeNull();
    });

    it('loads only the requested locale and English', async () => {
      const campaign = await draft(direct([alpha]));
      await reviewAndPublish(campaign);
      const [card] = (
        await repository.findMerchantCards(alpha, 'fr', 20)
      ).filter((row) => row.id === campaign.id);
      expect(card.translations.map((row) => row.locale)).toEqual(['en']);
      const [arabic] = (
        await repository.findMerchantCards(alpha, 'ar', 20)
      ).filter((row) => row.id === campaign.id);
      expect(arabic.translations.map((row) => row.locale).sort()).toEqual([
        'ar',
        'en',
      ]);
    });

    it('hides paused, expired and archived campaigns; resume keeps recipients', async () => {
      const campaign = await draft(direct([alpha, beta]));
      const published = await reviewAndPublish(campaign);
      if (published.kind !== 'published') throw new Error(published.kind);

      await repository.transition({
        id: campaign.id,
        from: 'published',
        next: 'paused',
        action: 'pause',
        audit: AUDIT,
      });
      expect(await cardIds(alpha)).not.toContain(campaign.id);
      await repository.recordEvent(campaign.id, alpha, 'view');

      await repository.transition({
        id: campaign.id,
        from: 'paused',
        next: 'published',
        action: 'resume',
        audit: AUDIT,
      });
      expect(await cardIds(alpha)).toContain(campaign.id);
      expect(await recipientIds(campaign.id)).toEqual([alpha, beta].sort());
      expect((await repository.analytics(campaign.id)).viewed).toBe(0);

      const stale = await repository.transition({
        id: campaign.id,
        from: 'paused',
        next: 'published',
        action: 'resume',
        audit: AUDIT,
      });
      expect(stale.kind).toBe('state_changed');

      await client`UPDATE tips_campaigns SET expires_at = now() - interval '1 second' WHERE id = ${campaign.id}`;
      expect(await cardIds(alpha)).not.toContain(campaign.id);
      await client`UPDATE tips_campaigns SET expires_at = NULL WHERE id = ${campaign.id}`;

      await repository.transition({
        id: campaign.id,
        from: 'published',
        next: 'archived',
        action: 'archive',
        audit: AUDIT,
      });
      expect(await cardIds(alpha)).not.toContain(campaign.id);
      expect(await recipientIds(campaign.id)).toEqual([alpha, beta].sort());
    });

    it('counts first events once, keeps them across edits, and dismisses per merchant', async () => {
      const campaign = await draft(direct([alpha, beta]), {
        action: { kind: 'internal', route: 'settings_timing' },
      });
      const noButton = await draft(direct([alpha]));
      await reviewAndPublish(campaign);
      await reviewAndPublish(noButton);

      await repository.recordEvent(campaign.id, alpha, 'view');
      const [{ first_viewed_at: firstView }] = await client<
        { first_viewed_at: string }[]
      >`
        SELECT first_viewed_at FROM tips_campaign_recipients WHERE campaign_id = ${campaign.id} AND org_id = ${alpha}`;
      await repository.recordEvent(campaign.id, alpha, 'view');
      await repository.recordEvent(campaign.id, alpha, 'click');
      await repository.recordEvent(campaign.id, alpha, 'click');
      await repository.recordEvent(campaign.id, alpha, 'dismiss');
      await repository.recordEvent(campaign.id, alpha, 'dismiss');
      await repository.recordEvent(noButton.id, alpha, 'click');
      // Another merchant's id never touches this campaign.
      await repository.recordEvent(campaign.id, outsider, 'dismiss');

      const [{ first_viewed_at: stillFirst }] = await client<
        { first_viewed_at: string }[]
      >`
        SELECT first_viewed_at FROM tips_campaign_recipients WHERE campaign_id = ${campaign.id} AND org_id = ${alpha}`;
      expect(stillFirst).toEqual(firstView);
      expect(await repository.analytics(campaign.id)).toEqual({
        recipients: 2,
        viewed: 1,
        clicked: 1,
        dismissed: 1,
      });
      expect((await repository.analytics(noButton.id)).clicked).toBe(0);

      expect(await cardIds(alpha)).not.toContain(campaign.id);
      expect(await cardIds(beta)).toContain(campaign.id);

      // A content edit reaches beta, resurfaces nothing and resets nothing.
      const current = (await repository.findById(campaign.id))!.campaign;
      const edited = await repository.update(
        campaign.id,
        current.revision,
        {
          translations: [
            {
              locale: 'en',
              title: 'Updated',
              description: 'New body.',
              action_label: 'Open',
            },
          ],
        },
        AUDIT,
      );
      expect(edited.kind).toBe('updated');
      if (edited.kind === 'updated') {
        expect(edited.campaign.publishedAt).toEqual(current.publishedAt);
        expect(edited.campaign.revision).toBe(current.revision + 1);
      }
      expect(await cardIds(alpha)).not.toContain(campaign.id);
      const [betaCard] = (
        await repository.findMerchantCards(beta, 'en', 20)
      ).filter((row) => row.id === campaign.id);
      expect(betaCard.translations[0].title).toBe('Updated');
      expect(await repository.analytics(campaign.id)).toEqual({
        recipients: 2,
        viewed: 1,
        clicked: 1,
        dismissed: 1,
      });

      const conflict = await repository.update(
        campaign.id,
        current.revision,
        { name: 'x' },
        AUDIT,
      );
      expect(conflict.kind).toBe('revision_conflict');
    });

    it('lists campaigns with analytics and pages frozen recipients', async () => {
      const page = await repository.listPage({ limit: 5 });
      expect(page.length).toBeGreaterThan(0);
      expect(page[0]).toEqual(
        expect.objectContaining({
          recipients: expect.any(Number),
          viewed: expect.any(Number),
        }),
      );
      const published = page.find((row) => row.status !== 'draft');
      if (published) {
        const recipients = await repository.pageRecipients(published.id, {
          limit: 50,
        });
        expect(recipients.length).toBe(published.recipients);
      }
    });
  });
});
