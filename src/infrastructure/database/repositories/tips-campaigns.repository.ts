import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { PREPAID_CREDIT_PLATFORMS } from '../../../shared/billing/credit-eligibility';
import { withSerializableRetry } from '../../../shared/database/serializable-retry';
import type { InterfaceLocale } from '../../../shared/i18n/interface-locales';
import { FALLBACK_INTERFACE_LOCALE } from '../../../shared/i18n/interface-locales';
import type {
  TipsAudience,
  TipsAudienceFeature,
  TipsCampaignAction,
  TipsCampaignStatus,
  TipsCampaignType,
  TipsTranslation,
} from '../../../shared/tips-campaigns/tips-campaign.types';
import { DRIZZLE, type DrizzleDB } from '../database.provider';
import {
  adminAccessAudit,
  tipsCampaignRecipients,
  tipsCampaignTranslations,
  tipsCampaigns,
} from '../schema';

type Transaction = Parameters<Parameters<DrizzleDB['transaction']>[0]>[0];

export type TipsCampaignRecord = typeof tipsCampaigns.$inferSelect;
export type TipsCampaignTranslationRecord =
  typeof tipsCampaignTranslations.$inferSelect;

export interface TipsAdminAudit {
  userId: string;
  requestId?: string;
}

export interface TipsCampaignContentWrite {
  name: string;
  type: TipsCampaignType;
  action: TipsCampaignAction | null;
  translations: TipsTranslation[];
}

export interface TipsCampaignDraftWrite extends TipsCampaignContentWrite {
  expiresAt: string | null;
  audience: TipsAudience;
}

/** Fields an edit changes; anything absent stays as stored. */
export interface TipsCampaignPatch {
  name?: string;
  type?: TipsCampaignType;
  action?: TipsCampaignAction | null;
  translations?: TipsTranslation[];
  expiresAt?: string | null;
  audience?: TipsAudience;
}

export interface TipsCampaignDetail {
  campaign: TipsCampaignRecord;
  translations: TipsCampaignTranslationRecord[];
}

export type TipsCampaignAnalytics = {
  recipients: number;
  viewed: number;
  clicked: number;
  dismissed: number;
};

export type TipsCampaignListRow = TipsCampaignAnalytics & {
  id: string;
  name: string;
  type: TipsCampaignType;
  status: TipsCampaignStatus;
  action_kind: string | null;
  published_at: string | null;
  expires_at: string | null;
  recipient_count: number | null;
  created_at: string;
};

export interface TipsAudienceSummary {
  count: number;
  hash: string;
}

/** One organization as the admin picker and recipient lists show it. */
export type TipsAudienceOrganizationRow = {
  org_id: string;
  organization_name: string | null;
  store_name: string | null;
  shop_domain: string | null;
  platform: string | null;
  country_code: string | null;
  excluded: boolean;
  first_viewed_at: string | null;
  first_clicked_at: string | null;
  dismissed_at: string | null;
};

/** Keyset position in a list sorted by display name, then id. */
export interface TipsNameCursor {
  name: string;
  id: string;
}

export interface TipsCreatedCursor {
  createdAt: string;
  id: string;
}

export type TipsMerchantCardRow = {
  id: string;
  type: TipsCampaignType;
  action_kind: 'internal' | 'external' | null;
  action_route: string | null;
  action_url: string | null;
  published_at: string;
  translations: TipsTranslation[];
};

export interface TipsRecipientVisibility {
  status: TipsCampaignStatus;
  expiresAt: string | null;
  actionKind: string | null;
}

export type TipsPublishOutcome =
  | { kind: 'not_found' }
  | { kind: 'already_published'; campaign: TipsCampaignRecord }
  | { kind: 'not_draft'; status: TipsCampaignStatus }
  | { kind: 'revision_mismatch' }
  | { kind: 'expired' }
  | { kind: 'audience_changed'; count: number }
  | { kind: 'no_recipients' }
  | { kind: 'too_large'; count: number }
  | { kind: 'published'; campaign: TipsCampaignRecord };

export type TipsUpdateOutcome =
  | { kind: 'not_found' }
  | { kind: 'revision_conflict' }
  | { kind: 'updated'; campaign: TipsCampaignRecord };

export type TipsTransitionOutcome =
  | { kind: 'not_found' }
  | { kind: 'state_changed' }
  | { kind: 'updated'; campaign: TipsCampaignRecord };

/** Each audience feature maps to one store column, never to input text. */
const FEATURE_COLUMNS: Record<TipsAudienceFeature, SQL> = {
  auto_cancel: sql.raw('i.auto_cancel_enabled'),
  quiet_hours: sql.raw('i.quiet_hours_enabled'),
  follow_up: sql.raw('i.follow_up_enabled'),
  escalation: sql.raw('i.escalation_enabled'),
  auto_verify: sql.raw('i.is_auto_verify_enabled'),
  logo_header: sql.raw('i.logo_header_enabled'),
};

const AUDIT_ACTIONS = {
  create: 'tips-campaign.create',
  update: 'tips-campaign.update',
  publish: 'tips-campaign.publish',
  pause: 'tips-campaign.pause',
  resume: 'tips-campaign.resume',
  archive: 'tips-campaign.archive',
} as const;

const SORT_NAME = sql.raw(
  "lower(COALESCE(NULLIF(btrim(i.store_name), ''), o.name, ''))",
);

function inList(values: readonly string[]): SQL {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );
}

function iso(column: SQL): SQL {
  return sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

function likePattern(search: string): string {
  return `%${search.toLocaleLowerCase().replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

/** Thrown inside a publish transaction to roll it back with an outcome. */
class PublishAbort extends Error {
  constructor(readonly outcome: TipsPublishOutcome) {
    super(outcome.kind);
  }
}

/**
 * Tips and updates campaigns, their translations and frozen recipients.
 * Every admin write and its `admin_access_audit` row commit together.
 */
@Injectable()
export class TipsCampaignsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  /**
   * The audience predicate over `organizations o JOIN integrations i` (the
   * org's single active store). Filters AND together; values inside a filter
   * OR together; a missing value (NULL country, NULL signup date, NULL
   * setting) never matches a filter. Exclusions apply only in filters mode.
   */
  audienceWhere(audience: TipsAudience, applyExclusions = true): SQL {
    const conditions: SQL[] = [];
    if (audience.mode === 'direct') {
      conditions.push(
        audience.selectedOrgIds.length
          ? sql`o.id IN (${inList(audience.selectedOrgIds)})`
          : sql`false`,
      );
      return sql.join(conditions, sql` AND `);
    }
    const filters = audience.filters;
    if (filters.countries?.length)
      conditions.push(
        sql`upper(i.country_code) IN (${inList(filters.countries)})`,
      );
    if (filters.platforms?.length)
      conditions.push(sql`i.platform_type IN (${inList(filters.platforms)})`);
    if (filters.signup_from)
      conditions.push(
        sql`o.created_at >= (${filters.signup_from}::date::timestamp AT TIME ZONE 'UTC')`,
      );
    if (filters.signup_to)
      conditions.push(
        sql`o.created_at < ((${filters.signup_to}::date + 1)::timestamp AT TIME ZONE 'UTC')`,
      );
    if (filters.message_languages?.length)
      conditions.push(
        sql`i.default_language::text IN (${inList(filters.message_languages)})`,
      );
    if (filters.plans?.length) {
      const shopifyPlans = filters.plans.filter((plan) => plan !== 'prepaid');
      const options: SQL[] = [];
      if (shopifyPlans.length)
        options.push(
          sql`(i.platform_type = 'shopify' AND lower(btrim(COALESCE(i.billing_status, ''))) IN ('active', 'not_required') AND i.billing_plan_id::text IN (${inList(shopifyPlans)}))`,
        );
      if (filters.plans.includes('prepaid'))
        options.push(
          sql`i.platform_type IN (${inList(PREPAID_CREDIT_PLATFORMS)})`,
        );
      conditions.push(sql`(${sql.join(options, sql` OR `)})`);
    }
    for (const [feature, enabled] of Object.entries(filters.features ?? {})) {
      const column = FEATURE_COLUMNS[feature as TipsAudienceFeature];
      if (column && typeof enabled === 'boolean')
        conditions.push(sql`${column} = ${enabled}`);
    }
    if (applyExclusions && audience.excludedOrgIds.length)
      conditions.push(sql`o.id NOT IN (${inList(audience.excludedOrgIds)})`);
    return conditions.length ? sql.join(conditions, sql` AND `) : sql`true`;
  }

  private audienceFrom(): SQL {
    return sql`organizations o JOIN integrations i ON i.org_id = o.id AND i.is_active = true`;
  }

  /** Recipient count and a hash of the sorted ids, for review and publish. */
  async summarizeAudience(
    audience: TipsAudience,
    executor: DrizzleDB | Transaction = this.db,
  ): Promise<TipsAudienceSummary> {
    const result = await executor.execute<{ count: number; hash: string }>(sql`
      WITH audience AS (
        SELECT DISTINCT o.id AS org_id
        FROM ${this.audienceFrom()}
        WHERE ${this.audienceWhere(audience)}
      )
      SELECT
        count(*)::int AS count,
        encode(sha256(convert_to(COALESCE(string_agg(org_id::text, ',' ORDER BY org_id), ''), 'UTF8')), 'hex') AS hash
      FROM audience
    `);
    const [row] = Array.from(result);
    return { count: Number(row?.count ?? 0), hash: String(row?.hash ?? '') };
  }

  /**
   * One page of an audience sorted by display name. With `markExclusions`,
   * excluded organizations stay in the list flagged, so the admin can undo.
   */
  async pageAudience(
    audience: TipsAudience,
    page: { search?: string; cursor?: TipsNameCursor; limit: number },
    markExclusions: boolean,
  ): Promise<TipsAudienceOrganizationRow[]> {
    const excluded =
      audience.mode === 'filters' && audience.excludedOrgIds.length
        ? sql`o.id IN (${inList(audience.excludedOrgIds)})`
        : sql`false`;
    const result = await this.db.execute<TipsAudienceOrganizationRow>(sql`
      SELECT DISTINCT ON (${SORT_NAME}, o.id)
        o.id AS org_id,
        o.name AS organization_name,
        i.store_name,
        CASE WHEN i.platform_type = 'standalone' THEN NULL ELSE i.platform_store_url END AS shop_domain,
        i.platform_type AS platform,
        upper(i.country_code) AS country_code,
        ${excluded} AS excluded,
        NULL::text AS first_viewed_at,
        NULL::text AS first_clicked_at,
        NULL::text AS dismissed_at,
        ${SORT_NAME} AS sort_name
      FROM ${this.audienceFrom()}
      WHERE ${this.audienceWhere(audience, !markExclusions)}
        AND ${this.searchCondition(page.search)}
        AND ${this.nameCursorCondition(page.cursor)}
      ORDER BY ${SORT_NAME}, o.id
      LIMIT ${page.limit}
    `);
    return Array.from(result);
  }

  /** Organizations with an active store, for direct selection. */
  async searchOrganizations(page: {
    search?: string;
    cursor?: TipsNameCursor;
    limit: number;
  }): Promise<TipsAudienceOrganizationRow[]> {
    return this.pageAudience(
      { mode: 'filters', filters: {}, selectedOrgIds: [], excludedOrgIds: [] },
      page,
      false,
    );
  }

  /** The known store countries among active stores, with counts. */
  async countryOptions(): Promise<{ country_code: string; count: number }[]> {
    const result = await this.db.execute<{
      country_code: string;
      count: number;
    }>(sql`
      SELECT upper(i.country_code) AS country_code, count(DISTINCT i.org_id)::int AS count
      FROM integrations i
      WHERE i.is_active = true AND i.country_code IS NOT NULL AND btrim(i.country_code) <> ''
      GROUP BY upper(i.country_code)
      ORDER BY upper(i.country_code)
    `);
    return Array.from(result).map((row) => ({
      country_code: row.country_code,
      count: Number(row.count),
    }));
  }

  async create(
    write: TipsCampaignDraftWrite,
    audit: TipsAdminAudit,
  ): Promise<TipsCampaignRecord> {
    return withSerializableRetry(() =>
      this.db.transaction(async (tx) => {
        const [campaign] = await tx
          .insert(tipsCampaigns)
          .values({
            name: write.name,
            type: write.type,
            ...this.actionColumns(write.action),
            expiresAt: write.expiresAt,
            ...this.audienceColumns(write.audience),
            createdBy: audit.userId,
            updatedBy: audit.userId,
          })
          .returning();
        await this.replaceTranslations(tx, campaign.id, write.translations);
        await this.audit(tx, AUDIT_ACTIONS.create, audit, {
          campaignId: campaign.id,
        });
        return campaign;
      }),
    );
  }

  async findById(id: string): Promise<TipsCampaignDetail | null> {
    const [campaign] = await this.db
      .select()
      .from(tipsCampaigns)
      .where(eq(tipsCampaigns.id, id))
      .limit(1);
    if (!campaign) return null;
    const translations = await this.db
      .select()
      .from(tipsCampaignTranslations)
      .where(eq(tipsCampaignTranslations.campaignId, id));
    return { campaign, translations };
  }

  /**
   * Applies an edit when `revision` still matches, bumping it, so a stale
   * editor or a stale review can never overwrite newer work.
   */
  async update(
    id: string,
    revision: number,
    patch: TipsCampaignPatch,
    audit: TipsAdminAudit,
  ): Promise<TipsUpdateOutcome> {
    return withSerializableRetry(() =>
      this.db.transaction(async (tx) => {
        const [current] = await tx
          .select({ id: tipsCampaigns.id, revision: tipsCampaigns.revision })
          .from(tipsCampaigns)
          .where(eq(tipsCampaigns.id, id))
          .for('update');
        if (!current) return { kind: 'not_found' } as const;
        if (current.revision !== revision)
          return { kind: 'revision_conflict' } as const;
        const [campaign] = await tx
          .update(tipsCampaigns)
          .set({
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.type !== undefined ? { type: patch.type } : {}),
            ...(patch.action !== undefined
              ? this.actionColumns(patch.action)
              : {}),
            ...(patch.expiresAt !== undefined
              ? { expiresAt: patch.expiresAt }
              : {}),
            ...(patch.audience ? this.audienceColumns(patch.audience) : {}),
            revision: sql`${tipsCampaigns.revision} + 1`,
            updatedBy: audit.userId,
            updatedAt: sql`now()`,
          })
          .where(eq(tipsCampaigns.id, id))
          .returning();
        if (patch.translations)
          await this.replaceTranslations(tx, id, patch.translations);
        await this.audit(tx, AUDIT_ACTIONS.update, audit, {
          campaignId: id,
          revision: campaign.revision,
          fields: Object.keys(patch),
        });
        return { kind: 'updated', campaign } as const;
      }),
    );
  }

  /** Records the reviewed audience against the revision it was computed on. */
  async saveReview(
    id: string,
    revision: number,
    summary: TipsAudienceSummary,
    userId: string,
  ): Promise<boolean> {
    const rows = await this.db
      .update(tipsCampaigns)
      .set({
        reviewedRevision: revision,
        reviewedAudienceHash: summary.hash,
        reviewedRecipientCount: summary.count,
        reviewedAt: sql`now()`,
        reviewedBy: userId,
      })
      .where(
        and(
          eq(tipsCampaigns.id, id),
          eq(tipsCampaigns.revision, revision),
          eq(tipsCampaigns.status, 'draft'),
        ),
      )
      .returning({ id: tipsCampaigns.id });
    return rows.length > 0;
  }

  /**
   * Freezes the recipients and activates the campaign in one transaction.
   * The recipients are inserted from the live audience and hashed in the same
   * statement; if that differs from what the admin reviewed, everything rolls
   * back, so merchants never see a partial or unreviewed snapshot. A retry
   * with the token that already published returns the published campaign.
   */
  async publish(params: {
    id: string;
    revision: number;
    reviewedHash: string;
    token: string;
    maxRecipients: number;
    audit: TipsAdminAudit;
  }): Promise<TipsPublishOutcome> {
    try {
      return await withSerializableRetry(() =>
        this.db.transaction(async (tx) => {
          const [campaign] = await tx
            .select()
            .from(tipsCampaigns)
            .where(eq(tipsCampaigns.id, params.id))
            .for('update');
          if (!campaign) return { kind: 'not_found' } as const;
          if (campaign.status !== 'draft') {
            return campaign.publishedReviewToken === params.token
              ? ({ kind: 'already_published', campaign } as const)
              : ({ kind: 'not_draft', status: campaign.status } as const);
          }
          if (campaign.revision !== params.revision)
            return { kind: 'revision_mismatch' } as const;
          if (
            campaign.expiresAt !== null &&
            Date.parse(campaign.expiresAt) <= Date.now()
          )
            return { kind: 'expired' } as const;

          const audience = this.audienceFromRecord(campaign);
          const result = await tx.execute<{ count: number; hash: string }>(sql`
            WITH inserted AS (
              INSERT INTO tips_campaign_recipients (campaign_id, org_id)
              SELECT DISTINCT ${params.id}::uuid, o.id
              FROM ${this.audienceFrom()}
              WHERE ${this.audienceWhere(audience)}
              ON CONFLICT DO NOTHING
              RETURNING org_id
            )
            SELECT
              count(*)::int AS count,
              encode(sha256(convert_to(COALESCE(string_agg(org_id::text, ',' ORDER BY org_id), ''), 'UTF8')), 'hex') AS hash
            FROM inserted
          `);
          const [inserted] = Array.from(result);
          const count = Number(inserted?.count ?? 0);
          const hash = String(inserted?.hash ?? '');
          if (count === 0) throw new PublishAbort({ kind: 'no_recipients' });
          if (count > params.maxRecipients)
            throw new PublishAbort({ kind: 'too_large', count });
          if (hash !== params.reviewedHash)
            throw new PublishAbort({ kind: 'audience_changed', count });

          const [published] = await tx
            .update(tipsCampaigns)
            .set({
              status: 'published',
              publishedAt: sql`now()`,
              publishedBy: params.audit.userId,
              publishedReviewToken: params.token,
              recipientCount: count,
              updatedBy: params.audit.userId,
              updatedAt: sql`now()`,
            })
            .where(eq(tipsCampaigns.id, params.id))
            .returning();
          await this.audit(tx, AUDIT_ACTIONS.publish, params.audit, {
            campaignId: params.id,
            recipientCount: count,
            revision: params.revision,
          });
          return { kind: 'published', campaign: published } as const;
        }),
      );
    } catch (error) {
      if (error instanceof PublishAbort) return error.outcome;
      throw error;
    }
  }

  /** Moves the campaign to `next` only if it is still in `from`. */
  async transition(params: {
    id: string;
    from: TipsCampaignStatus;
    next: TipsCampaignStatus;
    action: 'pause' | 'resume' | 'archive';
    audit: TipsAdminAudit;
  }): Promise<TipsTransitionOutcome> {
    return withSerializableRetry(() =>
      this.db.transaction(async (tx) => {
        const [campaign] = await tx
          .update(tipsCampaigns)
          .set({
            status: params.next,
            ...(params.action === 'pause' ? { pausedAt: sql`now()` } : {}),
            ...(params.action === 'resume' ? { pausedAt: null } : {}),
            ...(params.action === 'archive' ? { archivedAt: sql`now()` } : {}),
            updatedBy: params.audit.userId,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(tipsCampaigns.id, params.id),
              eq(tipsCampaigns.status, params.from),
            ),
          )
          .returning();
        if (!campaign) {
          const [exists] = await tx
            .select({ id: tipsCampaigns.id })
            .from(tipsCampaigns)
            .where(eq(tipsCampaigns.id, params.id));
          return exists
            ? ({ kind: 'state_changed' } as const)
            : ({ kind: 'not_found' } as const);
        }
        await this.audit(tx, AUDIT_ACTIONS[params.action], params.audit, {
          campaignId: params.id,
          from: params.from,
          to: params.next,
        });
        return { kind: 'updated', campaign } as const;
      }),
    );
  }

  /** One page of campaigns, newest first, with analytics for the page only. */
  async listPage(page: {
    status?: TipsCampaignStatus;
    search?: string;
    cursor?: TipsCreatedCursor;
    limit: number;
  }): Promise<TipsCampaignListRow[]> {
    const conditions: SQL[] = [sql`true`];
    if (page.status) conditions.push(sql`c.status = ${page.status}`);
    const search = page.search?.trim();
    if (search)
      conditions.push(
        sql`lower(c.name) LIKE ${likePattern(search)} ESCAPE '\\'`,
      );
    if (page.cursor)
      conditions.push(
        sql`(c.created_at, c.id) < (${page.cursor.createdAt}::timestamptz, ${page.cursor.id}::uuid)`,
      );
    const result = await this.db.execute<TipsCampaignListRow>(sql`
      WITH page AS (
        SELECT c.*
        FROM tips_campaigns c
        WHERE ${sql.join(conditions, sql` AND `)}
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT ${page.limit}
      ),
      stats AS (
        SELECT
          r.campaign_id,
          count(*)::int AS recipients,
          count(r.first_viewed_at)::int AS viewed,
          count(r.first_clicked_at)::int AS clicked,
          count(r.dismissed_at)::int AS dismissed
        FROM tips_campaign_recipients r
        WHERE r.campaign_id IN (SELECT id FROM page)
        GROUP BY r.campaign_id
      )
      SELECT
        page.id,
        page.name,
        page.type,
        page.status,
        page.action_kind,
        ${iso(sql`page.published_at`)} AS published_at,
        ${iso(sql`page.expires_at`)} AS expires_at,
        page.recipient_count,
        ${iso(sql`page.created_at`)} AS created_at,
        COALESCE(stats.recipients, 0) AS recipients,
        COALESCE(stats.viewed, 0) AS viewed,
        COALESCE(stats.clicked, 0) AS clicked,
        COALESCE(stats.dismissed, 0) AS dismissed
      FROM page
      LEFT JOIN stats ON stats.campaign_id = page.id
      ORDER BY page.created_at DESC, page.id DESC
    `);
    return Array.from(result).map((row) => ({
      ...row,
      recipients: Number(row.recipients),
      viewed: Number(row.viewed),
      clicked: Number(row.clicked),
      dismissed: Number(row.dismissed),
    }));
  }

  async analytics(id: string): Promise<TipsCampaignAnalytics> {
    const result = await this.db.execute<TipsCampaignAnalytics>(sql`
      SELECT
        count(*)::int AS recipients,
        count(first_viewed_at)::int AS viewed,
        count(first_clicked_at)::int AS clicked,
        count(dismissed_at)::int AS dismissed
      FROM tips_campaign_recipients
      WHERE campaign_id = ${id}::uuid
    `);
    const [row] = Array.from(result);
    return {
      recipients: Number(row?.recipients ?? 0),
      viewed: Number(row?.viewed ?? 0),
      clicked: Number(row?.clicked ?? 0),
      dismissed: Number(row?.dismissed ?? 0),
    };
  }

  /** The frozen recipients of a published campaign, with their timestamps. */
  async pageRecipients(
    id: string,
    page: { search?: string; cursor?: TipsNameCursor; limit: number },
  ): Promise<TipsAudienceOrganizationRow[]> {
    const result = await this.db.execute<TipsAudienceOrganizationRow>(sql`
      SELECT
        o.id AS org_id,
        o.name AS organization_name,
        i.store_name,
        CASE WHEN i.platform_type = 'standalone' THEN NULL ELSE i.platform_store_url END AS shop_domain,
        i.platform_type AS platform,
        upper(i.country_code) AS country_code,
        false AS excluded,
        ${iso(sql`r.first_viewed_at`)} AS first_viewed_at,
        ${iso(sql`r.first_clicked_at`)} AS first_clicked_at,
        ${iso(sql`r.dismissed_at`)} AS dismissed_at,
        ${SORT_NAME} AS sort_name
      FROM tips_campaign_recipients r
      JOIN organizations o ON o.id = r.org_id
      LEFT JOIN integrations i ON i.org_id = o.id AND i.is_active = true
      WHERE r.campaign_id = ${id}::uuid
        AND ${this.searchCondition(page.search)}
        AND ${this.nameCursorCondition(page.cursor)}
      ORDER BY ${SORT_NAME}, o.id
      LIMIT ${page.limit}
    `);
    return Array.from(result);
  }

  /**
   * The cards an organization sees now: its own undismissed recipient rows of
   * published, unexpired campaigns, newest publication first. Only the
   * requested locale and English are loaded.
   */
  async findMerchantCards(
    orgId: string,
    locale: InterfaceLocale,
    limit: number,
  ): Promise<TipsMerchantCardRow[]> {
    const locales = [...new Set([locale, FALLBACK_INTERFACE_LOCALE])];
    const result = await this.db.execute<TipsMerchantCardRow>(sql`
      SELECT
        c.id,
        c.type,
        c.action_kind,
        c.action_route,
        c.action_url,
        ${iso(sql`c.published_at`)} AS published_at,
        COALESCE(
          json_agg(
            json_build_object(
              'locale', t.locale,
              'title', t.title,
              'description', t.description,
              'action_label', t.action_label
            )
          ) FILTER (WHERE t.locale IS NOT NULL),
          '[]'::json
        ) AS translations
      FROM tips_campaign_recipients r
      JOIN tips_campaigns c ON c.id = r.campaign_id
      LEFT JOIN tips_campaign_translations t
        ON t.campaign_id = c.id AND t.locale IN (${inList(locales)})
      WHERE r.org_id = ${orgId}::uuid
        AND r.dismissed_at IS NULL
        AND c.status = 'published'
        AND (c.expires_at IS NULL OR c.expires_at > now())
      GROUP BY c.id
      ORDER BY c.published_at DESC, c.id DESC
      LIMIT ${limit}
    `);
    return Array.from(result);
  }

  /** The campaign state behind an organization's recipient row, if it has one. */
  async findRecipientVisibility(
    campaignId: string,
    orgId: string,
  ): Promise<TipsRecipientVisibility | null> {
    const [row] = await this.db
      .select({
        status: tipsCampaigns.status,
        expiresAt: tipsCampaigns.expiresAt,
        actionKind: tipsCampaigns.actionKind,
      })
      .from(tipsCampaignRecipients)
      .innerJoin(
        tipsCampaigns,
        eq(tipsCampaigns.id, tipsCampaignRecipients.campaignId),
      )
      .where(
        and(
          eq(tipsCampaignRecipients.campaignId, campaignId),
          eq(tipsCampaignRecipients.orgId, orgId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * First view, first click or dismissal for one organization. The first
   * timestamp wins, so repeats never move or inflate it. View and click count
   * only while the card is visible; dismissal holds in any published state.
   */
  async recordEvent(
    campaignId: string,
    orgId: string,
    event: 'view' | 'click' | 'dismiss',
  ): Promise<void> {
    const column = {
      view: sql.raw('first_viewed_at'),
      click: sql.raw('first_clicked_at'),
      dismiss: sql.raw('dismissed_at'),
    }[event];
    const visible =
      event === 'dismiss'
        ? sql`c.status <> 'draft'`
        : sql`c.status = 'published' AND (c.expires_at IS NULL OR c.expires_at > now()) AND r.dismissed_at IS NULL`;
    const needsAction =
      event === 'click' ? sql`AND c.action_kind IS NOT NULL` : sql``;
    await this.db.execute(sql`
      UPDATE tips_campaign_recipients r
      SET ${column} = COALESCE(r.${column}, now())
      FROM tips_campaigns c
      WHERE r.campaign_id = ${campaignId}::uuid
        AND r.org_id = ${orgId}::uuid
        AND c.id = r.campaign_id
        AND r.${column} IS NULL
        AND ${visible}
        ${needsAction}
    `);
  }

  audienceFromRecord(campaign: TipsCampaignRecord): TipsAudience {
    return {
      mode: campaign.targetingMode,
      filters: campaign.audienceFilters ?? {},
      selectedOrgIds: campaign.selectedOrgIds ?? [],
      excludedOrgIds: campaign.excludedOrgIds ?? [],
    };
  }

  private searchCondition(search: string | undefined): SQL {
    const term = search?.trim();
    if (!term) return sql`true`;
    const pattern = likePattern(term);
    return sql`(
      lower(COALESCE(i.store_name, '')) LIKE ${pattern} ESCAPE '\\'
      OR lower(COALESCE(o.name, '')) LIKE ${pattern} ESCAPE '\\'
      OR lower(CASE WHEN i.platform_type = 'standalone' THEN '' ELSE COALESCE(i.platform_store_url, '') END) LIKE ${pattern} ESCAPE '\\'
    )`;
  }

  private nameCursorCondition(cursor: TipsNameCursor | undefined): SQL {
    return cursor
      ? sql`(${SORT_NAME}, o.id) > (${cursor.name}, ${cursor.id}::uuid)`
      : sql`true`;
  }

  private actionColumns(action: TipsCampaignAction | null) {
    return {
      actionKind: action?.kind ?? null,
      actionRoute: action?.kind === 'internal' ? action.route : null,
      actionUrl: action?.kind === 'external' ? action.url : null,
    };
  }

  private audienceColumns(audience: TipsAudience) {
    return {
      targetingMode: audience.mode,
      audienceFilters: audience.filters,
      selectedOrgIds: audience.selectedOrgIds,
      excludedOrgIds: audience.excludedOrgIds,
    };
  }

  private async replaceTranslations(
    tx: Transaction,
    campaignId: string,
    translations: TipsTranslation[],
  ): Promise<void> {
    await tx
      .delete(tipsCampaignTranslations)
      .where(eq(tipsCampaignTranslations.campaignId, campaignId));
    if (!translations.length) return;
    await tx.insert(tipsCampaignTranslations).values(
      translations.map((row) => ({
        campaignId,
        locale: row.locale,
        title: row.title,
        description: row.description,
        actionLabel: row.action_label,
      })),
    );
  }

  private async audit(
    tx: Transaction,
    action: string,
    audit: TipsAdminAudit,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await tx.insert(adminAccessAudit).values({
      userId: audit.userId,
      action,
      outcome: 'allowed',
      requestId: audit.requestId,
      metadata,
    });
  }
}
