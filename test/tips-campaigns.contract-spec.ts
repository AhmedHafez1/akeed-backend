import {
  AnnouncementEmailsRepository,
  type AnnouncementDelivery,
} from '../src/infrastructure/database/repositories/announcement-emails.repository';
import type { EmailMessage } from '../src/shared/ports/email.port';
import { TipsService } from '../src/modules/tips/tips.service';
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate as migrateDrizzle } from 'drizzle-orm/postgres-js/migrator';
import * as schema from '../src/infrastructure/database';
import { AdminTipsCampaignsService } from '../src/modules/admin/admin-tips-campaigns.service';
import {
  TipsCampaignsRepository,
  type TipsCampaignRecord,
} from '../src/infrastructure/database/repositories/tips-campaigns.repository';
import { buildTipsReviewToken } from '../src/shared/tips-campaigns/tips-campaign.policy';
import {
  TIPS_CAMPAIGN_TYPES,
  type TipsAudience,
  type TipsAudienceFilters,
  type TipsCampaignAction,
  type TipsCampaignType,
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

const MIGRATIONS = [
  '0077_tips_campaigns.sql',
  '0080_tips_campaign_change_note_types.sql',
  '0084_tips_campaign_banner.sql',
  '0087_tips_recipient_deliveries.sql',
  '0105_announcement_email.sql',
];
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
const legacyCampaignId = randomUUID();
const legacyOrgId = randomUUID();
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
    type?: TipsCampaignType;
  } = {},
): Promise<TipsCampaignRecord> {
  const action = options.action ?? null;
  return repository.create(
    {
      name: options.name ?? 'Contract campaign',
      type: options.type ?? 'tip',
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
      CREATE TABLE whatsapp_connections (org_id uuid NOT NULL, state text NOT NULL);
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
        paid_through_at timestamptz,
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
    // Applying each again proves it re-runs cleanly.
    for (const file of MIGRATIONS) {
      if (file === '0084_tips_campaign_banner.sql') {
        await client`INSERT INTO tips_campaigns (id, name, type, created_by, updated_by)
          VALUES (${legacyCampaignId}, 'Existing campaign', 'tip', ${STAFF}, ${STAFF})`;
      }
      if (file === '0087_tips_recipient_deliveries.sql') {
        await client`INSERT INTO organizations (id,name) VALUES (${legacyOrgId}, 'Legacy account')`;
        await client`INSERT INTO tips_campaign_recipients (campaign_id,org_id,created_at,first_viewed_at,dismissed_at) VALUES (${legacyCampaignId},${legacyOrgId},'2026-10-20T10:00:00Z','2026-10-20T11:00:00Z','2026-10-20T12:00:00Z')`;
      }
      await migrate(file);
      await migrate(file);
    }

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

  describe('explicit recipient membership', () => {
    it('ships after 0084 while allowing the reserved WhatsApp migrations to run later', async () => {
      const journal = JSON.parse(
        readFileSync(
          resolve(__dirname, '../drizzle/meta/_journal.json'),
          'utf8',
        ),
      ) as {
        entries: {
          idx: number;
          version: string;
          when: number;
          tag: string;
          breakpoints: boolean;
        }[];
      };
      const tip = journal.entries.find(
        (entry) => entry.tag === '0087_tips_recipient_deliveries',
      )!;
      const baseline = journal.entries.find(
        (entry) => entry.tag === '0084_tips_campaign_banner',
      )!;
      const pendingWhen = [1794268800000, 1794355200000];
      expect(tip.when).toBeGreaterThan(baseline.when);
      expect(tip.when).toBeLessThan(pendingWhen[0]);
      const folder = mkdtempSync(join(tmpdir(), 'akeed-tips-order-'));
      if (
        dirname(folder) !== resolve(tmpdir()) ||
        !basename(folder).startsWith('akeed-tips-order-')
      ) {
        throw new Error('Unexpected migration test directory');
      }
      try {
        mkdirSync(join(folder, 'meta'));
        const entries = [{ ...baseline, tag: 'baseline' }];
        const writeJournal = () =>
          writeFileSync(
            join(folder, 'meta/_journal.json'),
            JSON.stringify({ version: '7', dialect: 'postgresql', entries }),
          );
        writeFileSync(
          join(folder, 'baseline.sql'),
          "CREATE TABLE tips_migration_order (step text PRIMARY KEY); INSERT INTO tips_migration_order VALUES ('0084');",
        );
        const db = drizzle(client);
        const config = {
          migrationsFolder: folder,
          migrationsSchema: namespace,
          migrationsTable: 'tips_order_migrations',
        };
        writeJournal();
        await migrateDrizzle(db, config);
        entries.push(tip);
        writeFileSync(
          join(folder, tip.tag + '.sql'),
          readFileSync(
            resolve(__dirname, '../drizzle', tip.tag + '.sql'),
            'utf8',
          ),
        );
        writeJournal();
        await migrateDrizzle(db, config);
        for (let index = 0; index < pendingWhen.length; index++) {
          const tag = 'pending_' + index;
          entries.push({
            ...baseline,
            idx: tip.idx + index + 1,
            tag,
            when: pendingWhen[index],
          });
          writeFileSync(
            join(folder, tag + '.sql'),
            `INSERT INTO tips_migration_order VALUES ('008${index + 5}');`,
          );
        }
        writeJournal();
        await migrateDrizzle(db, config);
        await migrateDrizzle(db, config);
        const steps = await client<
          { step: string }[]
        >`SELECT step FROM tips_migration_order ORDER BY step`;
        expect(steps.map((row) => row.step)).toEqual(['0084', '0085', '0086']);
        const applied = await client<
          { created_at: string }[]
        >`SELECT created_at FROM tips_order_migrations ORDER BY created_at`;
        expect(applied.map((row) => Number(row.created_at))).toEqual([
          baseline.when,
          tip.when,
          ...pendingWhen,
        ]);
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    });
    const testOrgs: string[] = [];
    const newMerchant = async (spec: StoreSpec = {}) => {
      const id = await merchant(spec);
      testOrgs.push(id);
      return id;
    };
    afterAll(async () => {
      await client.unsafe(
        'DELETE FROM organizations WHERE id = ANY($1::uuid[])',
        [testOrgs],
      );
    });
    const change = (
      id: string,
      revision: number,
      operation: 'add' | 'remove' | 'reissue',
      orgIds: string[],
      maxRecipients = MAX,
    ) =>
      repository.changeRecipients({
        id,
        revision,
        operation,
        orgIds,
        maxRecipients,
        audit: AUDIT,
      });

    it('backfills generation one without losing legacy engagement', async () => {
      const [row] =
        await client`SELECT * FROM tips_campaign_recipients WHERE campaign_id=${legacyCampaignId}`;
      expect(row.delivery_generation).toBe(1);
      expect(row.delivery_started_at).toEqual(row.created_at);
      expect(row.first_viewed_at).not.toBeNull();
      expect(row.dismissed_at).not.toBeNull();
    });

    it('keeps delivery history private to the service role', async () => {
      const [permissions] = await client`SELECT
        has_table_privilege('anon', ${namespace + '.tips_campaign_delivery_history'}, 'SELECT') AS anon,
        has_table_privilege('authenticated', ${namespace + '.tips_campaign_delivery_history'}, 'SELECT') AS authenticated,
        has_table_privilege('service_role', ${namespace + '.tips_campaign_delivery_history'}, 'SELECT') AS service`;
      expect(permissions).toEqual({
        anon: false,
        authenticated: false,
        service: true,
      });
      const [table] =
        await client`SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${namespace} AND c.relname='tips_campaign_delivery_history'`;
      expect(table.relrowsecurity).toBe(true);
      const policies =
        await client`SELECT roles FROM pg_policies WHERE schemaname=${namespace} AND tablename='tips_campaign_delivery_history'`;
      expect(policies).toHaveLength(1);
      expect(policies[0].roles).toEqual(['service_role']);
    });

    it('adds an unread account without changing publication, rules, or existing dismissals', async () => {
      const original = await newMerchant();
      const added = await newMerchant();
      const campaign = await draft(direct([original]));
      await reviewAndPublish(campaign);
      const before = (await repository.findById(campaign.id))!.campaign;
      await repository.recordEvent(campaign.id, original, 'dismiss');
      expect(
        await change(campaign.id, 1, 'add', [added, original]),
      ).toMatchObject({ kind: 'reissue_required' });
      expect(await change(campaign.id, 1, 'add', [added])).toEqual({
        kind: 'updated',
        changed: 1,
        unchanged: 0,
      });
      const after = (await repository.findById(campaign.id))!.campaign;
      expect(after.publishedAt).toEqual(before.publishedAt);
      expect(after.selectedOrgIds).toEqual(before.selectedOrgIds);
      expect(after.revision).toBe(2);
      expect(after.recipientCount).toBe(2);
      expect(
        (await repository.findMerchantCards(added, 'en', 20))[0],
      ).toMatchObject({
        id: campaign.id,
        delivery_generation: 1,
        first_viewed_at: null,
      });
      expect(await cardIds(original)).not.toContain(campaign.id);
      expect(await change(campaign.id, 2, 'add', [added])).toEqual({
        kind: 'updated',
        changed: 0,
        unchanged: 1,
      });
      expect((await repository.findById(campaign.id))!.campaign.revision).toBe(
        2,
      );
    });

    it('removes inactive accounts, preserves events, and requires an active store to reissue', async () => {
      const org = await newMerchant();
      const campaign = await draft(direct([org]));
      await reviewAndPublish(campaign);
      await repository.recordEvent(campaign.id, org, 'view');
      await client`UPDATE integrations SET is_active=false WHERE org_id=${org}`;
      expect(await change(campaign.id, 1, 'remove', [org])).toMatchObject({
        changed: 1,
      });
      expect(await cardIds(org)).not.toContain(campaign.id);
      expect(await repository.recordEvent(campaign.id, org, 'view')).toBe(
        false,
      );
      expect(
        await repository.findRecipientVisibility(campaign.id, org),
      ).toBeNull();
      expect(await change(campaign.id, 2, 'reissue', [org])).toMatchObject({
        kind: 'ineligible',
      });
      const rows = await repository.pageRecipients(campaign.id, { limit: 10 });
      expect(rows[0]).toMatchObject({
        eligible: false,
        delivery_generation: 1,
      });
      expect(rows[0].removed_at).not.toBeNull();
      expect(rows[0].first_viewed_at).not.toBeNull();
      expect(await repository.analytics(campaign.id)).toEqual({
        recipients: 0,
        viewed: 0,
        clicked: 0,
        dismissed: 0,
      });
      expect(await change(campaign.id, 2, 'remove', [org])).toMatchObject({
        changed: 0,
      });
      await client`UPDATE integrations SET is_active=true WHERE org_id=${org}`;
      expect(await change(campaign.id, 2, 'reissue', [org])).toMatchObject({
        changed: 1,
      });
      expect(
        (await repository.deliveryHistory(campaign.id, org, undefined, 10))[0]
          .removed_at,
      ).not.toBeNull();
    });

    it('archives each dismissed delivery, marks reissues unread, and ignores old-tab events', async () => {
      const org = await newMerchant();
      const campaign = await draft(direct([org]), {
        action: { kind: 'internal', route: 'settings_message' },
      });
      await reviewAndPublish(campaign);
      for (const event of ['view', 'click', 'dismiss'] as const)
        expect(await repository.recordEvent(campaign.id, org, event)).toBe(
          true,
        );
      expect(await change(campaign.id, 1, 'reissue', [org])).toMatchObject({
        changed: 1,
      });
      const card = (await repository.findMerchantCards(org, 'en', 20))[0];
      expect(card).toMatchObject({
        delivery_generation: 2,
        first_viewed_at: null,
      });
      for (const event of ['view', 'click', 'dismiss'] as const)
        expect(await repository.recordEvent(campaign.id, org, event)).toBe(
          false,
        );
      expect(await repository.recordEvent(campaign.id, org, 'dismiss', 1)).toBe(
        false,
      );
      expect(await change(campaign.id, 1, 'reissue', [org])).toEqual({
        kind: 'revision_conflict',
      });
      expect(await change(campaign.id, 2, 'reissue', [org])).toMatchObject({
        changed: 0,
      });
      expect(await repository.recordEvent(campaign.id, org, 'dismiss', 2)).toBe(
        true,
      );
      await change(campaign.id, 2, 'reissue', [org]);
      const history = await repository.deliveryHistory(
        campaign.id,
        org,
        undefined,
        1,
      );
      expect(history[0].delivery_generation).toBe(2);
      const prior = await repository.deliveryHistory(campaign.id, org, 2, 10);
      expect(prior[0]).toMatchObject({
        delivery_generation: 1,
        first_viewed_at: expect.any(String),
        first_clicked_at: expect.any(String),
        dismissed_at: expect.any(String),
      });
      expect(
        (
          await repository.pageRecipientOptions(campaign.id, { limit: 500 })
        ).find((row) => row.org_id === org),
      ).toMatchObject({
        delivery_generation: 3,
        first_viewed_at: null,
        dismissed_at: null,
      });
    });

    it('rejects mixed ineligible selections, unknown reissues, and audience overflow atomically', async () => {
      const original = await newMerchant();
      const added = await newMerchant();
      const inactive = await newMerchant({ active: false });
      const campaign = await draft(direct([original]));
      await reviewAndPublish(campaign);
      expect(
        await change(campaign.id, 1, 'add', [added, inactive]),
      ).toMatchObject({ kind: 'ineligible', orgIds: [inactive] });
      expect(await change(campaign.id, 1, 'reissue', [added])).toMatchObject({
        kind: 'not_enrolled',
      });
      expect(await change(campaign.id, 1, 'add', [added], 1)).toMatchObject({
        kind: 'too_large',
        count: 2,
      });
      expect(await recipientIds(campaign.id)).toEqual([original]);
      expect((await repository.findById(campaign.id))!.campaign.revision).toBe(
        1,
      );
    });

    it('allows paused edits and refuses drafts, expired campaigns, and archived campaigns', async () => {
      const org = await newMerchant();
      const added = await newMerchant();
      const campaign = await draft(direct([org]));
      expect(await change(campaign.id, 1, 'add', [added])).toMatchObject({
        kind: 'invalid_transition',
      });
      await reviewAndPublish(campaign);
      await repository.transition({
        id: campaign.id,
        from: 'published',
        next: 'paused',
        action: 'pause',
        audit: AUDIT,
      });
      expect(await change(campaign.id, 1, 'add', [added])).toMatchObject({
        changed: 1,
      });
      expect(await cardIds(added)).not.toContain(campaign.id);
      await client`UPDATE tips_campaigns SET expires_at=now()-interval '1 second' WHERE id=${campaign.id}`;
      expect(await change(campaign.id, 2, 'remove', [added])).toMatchObject({
        kind: 'expired',
      });
      await client`UPDATE tips_campaigns SET status='archived' WHERE id=${campaign.id}`;
      expect(await change(campaign.id, 2, 'remove', [added])).toMatchObject({
        kind: 'invalid_transition',
      });
    });

    it('rolls history, unread state, revision, and counts back if auditing fails', async () => {
      const org = await newMerchant();
      const campaign = await draft(direct([org]));
      await reviewAndPublish(campaign);
      await repository.recordEvent(campaign.id, org, 'dismiss');
      await client.unsafe(
        "ALTER TABLE admin_access_audit ADD CONSTRAINT refuse_recipient_audit CHECK (action NOT LIKE 'tips-campaign.recipients.%') NOT VALID",
      );
      try {
        await expect(
          change(campaign.id, 1, 'reissue', [org]),
        ).rejects.toThrow();
      } finally {
        await client.unsafe(
          'ALTER TABLE admin_access_audit DROP CONSTRAINT refuse_recipient_audit',
        );
      }
      expect(
        await repository.deliveryHistory(campaign.id, org, undefined, 10),
      ).toEqual([]);
      expect((await repository.findById(campaign.id))!.campaign.revision).toBe(
        1,
      );
      expect(await cardIds(org)).not.toContain(campaign.id);
    });

    it('serializes concurrent edits and publication without partial enrollments', async () => {
      const org = await newMerchant();
      const first = await newMerchant();
      const second = await newMerchant();
      const campaign = await draft(direct([org]));
      const results = await Promise.all([
        reviewAndPublish(campaign),
        change(campaign.id, 1, 'add', [first]),
      ]);
      expect(['updated', 'invalid_transition']).toContain(results[1].kind);
      const revision = (await repository.findById(campaign.id))!.campaign
        .revision;
      const concurrent = await Promise.all([
        change(campaign.id, revision, 'add', [second]),
        change(campaign.id, revision, 'remove', [org]),
      ]);
      expect(concurrent.map((row) => row.kind).sort()).toEqual([
        'revision_conflict',
        'updated',
      ]);
      const current = (await repository.findById(campaign.id))!.campaign;
      const [count] =
        await client`SELECT count(*)::int AS count FROM tips_campaign_recipients WHERE campaign_id=${campaign.id} AND removed_at IS NULL`;
      expect(current.recipientCount).toBe(count.count);
    });

    it('surfaces an old reissued campaign ahead of the twenty-card cap without changing its publication date', async () => {
      const org = await newMerchant();
      const older = await draft(direct([org]));
      await reviewAndPublish(older);
      await client`UPDATE tips_campaigns SET published_at='2026-01-01' WHERE id=${older.id}`;
      await client`UPDATE tips_campaign_recipients SET delivery_started_at='2026-01-01' WHERE campaign_id=${older.id}`;
      for (let index = 0; index < 21; index++) {
        const campaign = await draft(direct([org]));
        await reviewAndPublish(campaign);
      }
      expect(await cardIds(org)).not.toContain(older.id);
      await repository.recordEvent(older.id, org, 'dismiss');
      await change(older.id, 1, 'reissue', [org]);
      expect((await cardIds(org))[0]).toBe(older.id);
      expect(
        new Date(
          (await repository.findById(older.id))!.campaign.publishedAt!,
        ).getUTCFullYear(),
      ).toBe(2026);
    });
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

  describe('campaign types', () => {
    it('stores every type and refuses an unknown one', async () => {
      for (const type of TIPS_CAMPAIGN_TYPES) {
        const campaign = await draft(filters({ countries: ['AU'] }), { type });
        expect((await repository.findById(campaign.id))?.campaign.type).toBe(
          type,
        );
      }
      const campaign = await draft(filters({ countries: ['AU'] }));
      await expect(
        client`UPDATE tips_campaigns SET type = 'promo' WHERE id = ${campaign.id}`,
      ).rejects.toThrow(/tips_campaigns_type_check/);
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

      const beforeRead = await repository.findMerchantCards(alpha, 'en', 20);
      expect(
        beforeRead.find((card) => card.id === campaign.id)?.first_viewed_at,
      ).toBeNull();
      await repository.recordEvent(campaign.id, alpha, 'view');
      const afterRead = await repository.findMerchantCards(alpha, 'en', 20);
      expect(
        afterRead.find((card) => card.id === campaign.id)?.first_viewed_at,
      ).toEqual(expect.any(String));
      const otherStore = await repository.findMerchantCards(beta, 'en', 20);
      expect(
        otherStore.find((card) => card.id === campaign.id)?.first_viewed_at,
      ).toBeNull();
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
  describe('banner setting', () => {
    const admin = new AdminTipsCampaignsService(repository);

    it('defaults existing and new campaigns to off and refuses null', async () => {
      expect(
        (await repository.findById(legacyCampaignId))?.campaign.showAsBanner,
      ).toBe(false);
      const campaign = await draft(filters({}));
      expect(campaign.showAsBanner).toBe(false);
      await expect(
        client`UPDATE tips_campaigns SET show_as_banner = NULL WHERE id = ${campaign.id}`,
      ).rejects.toThrow();
    });

    it.each(TIPS_CAMPAIGN_TYPES)(
      'switches a published %s without changing review, revision or recipients',
      async (type) => {
        const orgId = await merchant();
        const campaign = await draft(direct([orgId]), { type });
        await reviewAndPublish(campaign);
        const before = (await repository.findById(campaign.id))!.campaign;
        const changed = await admin.setBanner(AUDIT, campaign.id, true);
        expect(changed.show_as_banner).toBe(true);
        const after = (await repository.findById(campaign.id))!.campaign;
        for (const key of [
          'revision',
          'reviewedRevision',
          'reviewedAudienceHash',
          'reviewedAt',
          'publishedAt',
          'recipientCount',
        ] as const)
          expect(after[key]).toEqual(before[key]);
        expect(await recipientIds(campaign.id)).toEqual([orgId]);
        expect(
          (await repository.findMerchantCards(orgId, 'en', 20)).find(
            (row) => row.id === campaign.id,
          )?.show_as_banner,
        ).toBe(true);
        expect(
          (await admin.list({ search: campaign.name, limit: 100 })).items.find(
            (row) => row.id === campaign.id,
          )?.show_as_banner,
        ).toBe(true);
        const audits = await client<
          { metadata: unknown }[]
        >`SELECT metadata FROM admin_access_audit WHERE action = 'tips-campaign.banner' AND metadata->>'campaignId' = ${campaign.id}`;
        expect(audits).toEqual([
          { metadata: { campaignId: campaign.id, showAsBanner: true } },
        ]);
        const updatedAt = after.updatedAt;
        await admin.setBanner(AUDIT, campaign.id, true);
        expect(
          (await repository.findById(campaign.id))!.campaign.updatedAt,
        ).toBe(updatedAt);
        const [count] = await client<
          { count: number }[]
        >`SELECT count(*)::int AS count FROM admin_access_audit WHERE action = 'tips-campaign.banner' AND metadata->>'campaignId' = ${campaign.id}`;
        expect(count.count).toBe(1);
        await admin.setBanner(AUDIT, campaign.id, false);
        expect(
          (await repository.findMerchantCards(orgId, 'en', 20))[0]
            .show_as_banner,
        ).toBe(false);
      },
    );

    it('keeps a reviewed draft publishable and refuses archived writes', async () => {
      const campaign = await draft(direct([await merchant()]));
      const summary = await repository.summarizeAudience(
        repository.audienceFromRecord(campaign),
      );
      await repository.saveReview(
        campaign.id,
        campaign.revision,
        summary,
        STAFF,
      );
      const review = await admin.review(AUDIT, campaign.id);
      await admin.setBanner(AUDIT, campaign.id, true);
      await expect(
        admin.publish(AUDIT, campaign.id, review.review_token),
      ).resolves.toMatchObject({ status: 'published', show_as_banner: true });
      await admin.changeLifecycle(AUDIT, campaign.id, 'archive');
      await expect(
        admin.setBanner(AUDIT, campaign.id, true),
      ).rejects.toMatchObject({
        response: { code: 'TIPS_CAMPAIGN_NOT_EDITABLE' },
      });
      expect(
        await repository.setBanner({
          id: campaign.id,
          showAsBanner: false,
          audit: AUDIT,
        }),
      ).toEqual({ kind: 'state_changed' });
    });

    it('rolls the setting back when the audit cannot be written', async () => {
      const campaign = await draft(filters({}));
      await client.unsafe(
        "ALTER TABLE admin_access_audit ADD CONSTRAINT refuse_banner_audit CHECK (action <> 'tips-campaign.banner') NOT VALID",
      );
      try {
        await expect(
          repository.setBanner({
            id: campaign.id,
            showAsBanner: true,
            audit: AUDIT,
          }),
        ).rejects.toThrow();
        expect(
          (await repository.findById(campaign.id))!.campaign.showAsBanner,
        ).toBe(false);
      } finally {
        await client.unsafe(
          'ALTER TABLE admin_access_audit DROP CONSTRAINT refuse_banner_audit',
        );
      }
    });
  });
  describe('announcement email outbox', () => {
    it('renders a secondary-only card as one complete locale bundle and counts its clicks', async () => {
      const orgId = await merchant();
      const campaign = await draft(direct([orgId]), {
        name: 'Secondary guide only',
      });
      await repository.update(
        campaign.id,
        campaign.revision,
        {
          secondaryAction: {
            action: { kind: 'internal', route: 'guide_own_whatsapp_number' },
            labels: { en: 'How it works' },
          },
        },
        AUDIT,
      );
      const current = (await repository.findById(campaign.id))!.campaign;
      await reviewAndPublish(current);
      const tips = new TipsService(repository);
      const user = {
        orgId,
        userId: STAFF,
        role: 'owner' as const,
        source: 'supabase' as const,
      };
      const cards = await tips.getCards(user, 'ar');
      expect(cards.cards[0]).toMatchObject({
        locale: 'en',
        secondary_action: {
          kind: 'internal',
          route: 'guide_own_whatsapp_number',
          label: 'How it works',
        },
      });
      await tips.recordEvent(user, campaign.id, 'click');
      expect(await repository.analytics(campaign.id)).toMatchObject({
        clicked: 1,
      });
      const admin = new AdminTipsCampaignsService(repository);
      expect(
        (await admin.list({ search: 'Secondary guide only' })).items[0]
          .has_action,
      ).toBe(true);
    });
    const emails = new AnnouncementEmailsRepository(
      drizzle(client, { schema }) as never,
    );
    const message = {
      to: 'synthetic@example.test',
      from: 'Akeed <synthetic@example.test>',
      subject: 'Launch',
      text: 'Hello',
      html: '<p>Hello</p>',
      idempotencyKey: 'synthetic-key',
    };

    beforeEach(async () => {
      await client`TRUNCATE announcement_email_deliveries, announcement_email_preferences`;
      await client`UPDATE announcement_email_dispatch_state SET next_batch_at = now() - interval '1 minute', lease_until = NULL, claim_token = NULL`;
    });

    async function publishEmail(ids: string[]) {
      const campaign = await draft(direct(ids));
      const updated = await repository.update(
        campaign.id,
        campaign.revision,
        {
          email: {
            translations: [
              { locale: 'en', subject: 'Launch', body: 'Hello {storeName}' },
            ],
          },
        },
        AUDIT,
      );
      if (updated.kind !== 'updated')
        throw new Error('Could not prepare synthetic campaign');
      await reviewAndPublish(updated.campaign);
      return updated.campaign;
    }
    async function claim() {
      const token = await emails.claimSweep(300000);
      if (!token) throw new Error('Expected an available sweep');
      const row = await emails.claimNext(token);
      if (!row) throw new Error('Expected a pending delivery');
      return { token, row };
    }
    async function prepare(row: AnnouncementDelivery) {
      const saved = await emails.prepare(row, {
        ...message,
        idempotencyKey: `announcement-${row.campaignId}-${row.orgId}`,
      });
      if (!saved) throw new Error('Expected a saved envelope');
      const started = await emails.startAttempt(saved);
      if (!started) throw new Error('Expected an attempt');
      return started;
    }

    it('freezes one row per recipient, repeats publish safely, and never emails later card additions', async () => {
      const a = await merchant(),
        b = await merchant(),
        extra = await merchant();
      const campaign = await publishEmail([a, b]);
      const repeated = await reviewAndPublish(campaign);
      expect(repeated.kind).toBe('already_published');
      expect(await emails.stats(campaign.id)).toMatchObject({
        pending: 2,
        sent: 0,
      });
      const current = (await repository.findById(campaign.id))!.campaign;
      await repository.changeRecipients({
        id: campaign.id,
        revision: current.revision,
        operation: 'add',
        orgIds: [extra],
        maxRecipients: MAX,
        audit: AUDIT,
      });
      expect(await emails.stats(campaign.id)).toMatchObject({ pending: 2 });
    });

    it('rejects unknown placeholders at review and freezes published email content', async () => {
      const a = await merchant();
      const campaign = await draft(direct([a]));
      await repository.update(
        campaign.id,
        campaign.revision,
        {
          email: {
            translations: [
              { locale: 'en', subject: 'Launch', body: '{unknown}' },
            ],
          },
        },
        AUDIT,
      );
      const admin = new AdminTipsCampaignsService(repository);
      await expect(admin.review(AUDIT, campaign.id)).rejects.toMatchObject({
        response: {
          code: 'TIPS_CAMPAIGN_INVALID',
          issues: [
            { field: 'email', code: 'unknown_placeholder', locale: 'en' },
          ],
        },
      });
      expect(await recipientIds(campaign.id)).toEqual([]);
      const published = await publishEmail([a]);
      await expect(
        admin.update(AUDIT, published.id, {
          revision: published.revision,
          email: {
            translations: [
              { locale: 'en', subject: 'Changed', body: 'Different' },
            ],
          },
        }),
      ).rejects.toMatchObject({
        response: { code: 'TIPS_CAMPAIGN_NOT_EDITABLE' },
      });
    });

    it('rolls both channels back on a changed audience and on a rejected publication audit', async () => {
      const a = await merchant();
      const campaign = await draft(direct([a]));
      await repository.update(
        campaign.id,
        1,
        {
          email: {
            translations: [{ locale: 'en', subject: 'Launch', body: 'Hello' }],
          },
        },
        AUDIT,
      );
      const current = (await repository.findById(campaign.id))!.campaign;
      const result = await repository.publish({
        id: current.id,
        revision: current.revision,
        reviewedHash: 'bad-hash',
        token: 'synthetic',
        maxRecipients: MAX,
        audit: AUDIT,
      });
      expect(result.kind).toBe('audience_changed');
      expect(await recipientIds(current.id)).toEqual([]);
      expect(await emails.stats(current.id)).toMatchObject({ pending: 0 });
      await client.unsafe(
        "ALTER TABLE admin_access_audit ADD CONSTRAINT refuse_email_publish CHECK (action <> 'tips-campaign.publish') NOT VALID",
      );
      try {
        await expect(reviewAndPublish(current)).rejects.toThrow();
      } finally {
        await client.unsafe(
          'ALTER TABLE admin_access_audit DROP CONSTRAINT refuse_email_publish',
        );
      }
      expect(await recipientIds(current.id)).toEqual([]);
      expect(await emails.stats(current.id)).toMatchObject({ pending: 0 });
    });

    it('serializes sweep pacing and fences an expired row claim after worker restart', async () => {
      await publishEmail([await merchant()]);
      const tokens = await Promise.all([
        emails.claimSweep(300000),
        emails.claimSweep(300000),
      ]);
      expect(tokens.filter(Boolean)).toHaveLength(1);
      const token = tokens.find(Boolean)!;
      const old = (await emails.claimNext(token))!;
      await emails.finishSweep(token);
      expect(await emails.claimSweep(300000)).toBeNull();
      await client`UPDATE announcement_email_dispatch_state SET next_batch_at = now() - interval '1 minute'`;
      await client`UPDATE announcement_email_deliveries SET lease_until = now() - interval '1 minute'`;
      const next = await claim();
      expect(next.row.claimToken).not.toBe(old.claimToken);
      expect(await emails.prepare(old, message)).toBeNull();
      const send = jest.fn().mockResolvedValue({ status: 'sent' });
      await emails.dispatch(old, () => true, send);
      expect(send).not.toHaveBeenCalled();
      await emails.finishSweep(next.token);
    });

    it('uses the unchanged saved envelope after a lost provider response or result transaction', async () => {
      const campaign = await publishEmail([await merchant()]);
      const first = await claim();
      const started = await prepare(first.row);
      const accepted = new Set<string>();
      const send = jest.fn((payload: EmailMessage) => {
        accepted.add(payload.idempotencyKey!);
        return Promise.resolve({ status: 'sent' as const });
      });
      await client.unsafe(
        "ALTER TABLE admin_access_audit ADD CONSTRAINT refuse_email_result CHECK (action <> 'tips-campaign.email.send') NOT VALID",
      );
      try {
        await expect(
          emails.dispatch(started, () => true, send),
        ).rejects.toThrow();
      } finally {
        await client.unsafe(
          'ALTER TABLE admin_access_audit DROP CONSTRAINT refuse_email_result',
        );
      }
      const [persisted] =
        await client`SELECT first_attempt_at, email_payload, status FROM announcement_email_deliveries WHERE campaign_id = ${campaign.id}`;
      expect(persisted.first_attempt_at).not.toBeNull();
      expect(persisted.status).toBe('processing');
      await client`UPDATE announcement_email_deliveries SET lease_until = now() - interval '1 minute'`;
      await client`UPDATE announcement_email_dispatch_state SET next_batch_at = now() - interval '1 minute', lease_until = NULL, claim_token = NULL`;
      const retry = await claim();
      const retryStarted = (await emails.startAttempt(retry.row))!;
      await emails.dispatch(retryStarted, () => true, send);
      expect(send.mock.calls[0][0]).toEqual(send.mock.calls[1][0]);
      expect(accepted.size).toBe(1);
      expect(await emails.stats(campaign.id)).toMatchObject({
        sent: 1,
        processing: 0,
      });
      expect(await emails.claimNext(retry.token)).toBeNull();
    });

    it('bounds retries and refuses to resend after the provider replay window', async () => {
      const campaign = await publishEmail([await merchant()]);
      const { token, row } = await claim();
      const started = await prepare(row);
      const send = jest.fn().mockResolvedValue({
        status: 'failed',
        reason: 'provider_unreachable',
        retryable: true,
        uncertain: true,
      });
      await emails.dispatch(started, () => true, send);
      expect(await emails.stats(campaign.id)).toMatchObject({ pending: 1 });
      await client`UPDATE announcement_email_deliveries SET first_attempt_at = now() - interval '25 hours', next_attempt_at = now() - interval '1 minute'`;
      const next = (await emails.claimNext(token))!;
      expect(await emails.startAttempt(next)).toBeNull();
      await emails.fail(next, 'provider_outcome_unresolved');
      expect(await emails.stats(campaign.id)).toMatchObject({
        failed: 1,
        reasons: { provider_outcome_unresolved: 1 },
      });
      expect(send).toHaveBeenCalledTimes(1);
      expect(await emails.claimNext(token)).toBeNull();
    });

    it('allows five attempts, then settles the refusal without a sixth send', async () => {
      const campaign = await publishEmail([await merchant()]);
      const token = (await emails.claimSweep(300000))!;
      const send = jest.fn();
      send.mockResolvedValue({
        status: 'failed',
        reason: 'provider_status_503',
        retryable: true,
        uncertain: true,
      });
      for (let attempt = 1; attempt <= 5; attempt++) {
        await client`UPDATE announcement_email_deliveries SET next_attempt_at = now() - interval '1 minute'`;
        const row = (await emails.claimNext(token))!;
        const started = await prepare(row);
        expect(started.attempts).toBe(attempt);
        await emails.dispatch(started, () => true, send);
      }
      expect(send).toHaveBeenCalledTimes(5);
      expect(await emails.stats(campaign.id)).toMatchObject({
        failed: 1,
        pending: 0,
      });
      expect(await emails.claimNext(token)).toBeNull();
    });

    it('denies database client access to envelopes and announcement preferences', async () => {
      for (const role of ['anon', 'authenticated']) {
        await expect(
          client.begin(async (tx) => {
            await tx.unsafe('SET LOCAL ROLE ' + role);
            await tx.unsafe('SELECT * FROM announcement_email_deliveries');
          }),
        ).rejects.toThrow();
        await expect(
          client.begin(async (tx) => {
            await tx.unsafe('SET LOCAL ROLE ' + role);
            await tx.unsafe(
              'INSERT INTO announcement_email_preferences (org_id) VALUES (gen_random_uuid())',
            );
          }),
        ).rejects.toThrow();
      }
    });

    it('permanent Stop serializes with an in-flight send and skips claimed or pending rows', async () => {
      const campaign = await publishEmail([await merchant(), await merchant()]);
      const { token, row } = await claim();
      const started = await prepare(row);
      let release!: () => void;
      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const send = jest.fn(async () => {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { status: 'sent' as const };
      });
      const dispatch = emails.dispatch(started, () => true, send);
      await waiting;
      const stop = emails.stop(campaign.id, AUDIT);
      release();
      await Promise.all([dispatch, stop]);
      await emails.stop(campaign.id, AUDIT);
      expect(await emails.stats(campaign.id)).toMatchObject({
        sent: 1,
        skipped: 1,
        reasons: { stopped: 1 },
      });
      expect(await emails.claimNext(token)).toBeNull();
      const audits =
        await client`SELECT id FROM admin_access_audit WHERE action = 'tips-campaign.email.stop' AND metadata->>'campaignId' = ${campaign.id}`;
      expect(audits).toHaveLength(1);
    });

    it('holds disabled sends and skips opt-outs/inactive stores without affecting another organization', async () => {
      const a = await merchant(),
        b = await merchant();
      const campaign = await publishEmail([a, b]);
      const { token, row } = await claim();
      const started = await prepare(row);
      const send = jest.fn().mockResolvedValue({ status: 'sent' });
      await emails.dispatch(started, () => false, send);
      expect(send).not.toHaveBeenCalled();
      await emails.unsubscribe(a);
      await emails.unsubscribe(a);
      await client`UPDATE integrations SET is_active = false WHERE org_id = ${b}`;
      await client`UPDATE announcement_email_deliveries SET next_attempt_at = now() - interval '1 minute'`;
      for (let n = 0; n < 2; n++) {
        const next = (await emails.claimNext(token))!;
        const attempt = await prepare(next);
        await emails.dispatch(attempt, () => true, send);
      }
      expect(send).not.toHaveBeenCalled();
      expect(await emails.stats(campaign.id)).toMatchObject({
        skipped: 2,
        reasons: { unsubscribed: 1, inactive: 1 },
      });
      const preferences = await client<
        { org_id: string }[]
      >`SELECT org_id FROM announcement_email_preferences`;
      expect(preferences.map((p) => p.org_id)).toEqual([a]);
    });

    it('filters every non-disconnected connection as connected without duplicating organizations', async () => {
      const connected = await merchant(),
        disconnected = await merchant(),
        absent = await merchant();
      await client`INSERT INTO whatsapp_connections (org_id,state) VALUES (${connected},'degraded'),(${connected},'connecting'),(${disconnected},'disconnected')`;
      expect(
        await matches(filters({ own_number_connection: 'connected' })),
      ).toContain(connected);
      expect(
        await matches(filters({ own_number_connection: 'not_connected' })),
      ).toEqual(expect.arrayContaining([disconnected, absent]));
      expect(
        await matches(filters({ own_number_connection: 'not_connected' })),
      ).not.toContain(connected);
      expect(
        (await matches(filters({ own_number_connection: 'connected' }))).filter(
          (id) => id === connected,
        ),
      ).toHaveLength(1);
    });
  });
});
