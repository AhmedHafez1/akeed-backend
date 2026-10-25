import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  TipsCampaignsRepository,
  type TipsAdminAudit,
  type TipsAudienceOrganizationRow,
  type TipsCampaignAnalytics,
  type TipsCampaignDetail,
  type TipsCampaignPatch,
  type TipsCampaignRecord,
  type TipsNameCursor,
} from '../../infrastructure/database/repositories/tips-campaigns.repository';
import { BILLING_PLAN_IDS } from '../../shared/billing/billing-plan';
import { INTERFACE_LOCALES } from '../../shared/i18n/interface-locales';
import { buildBackendLog } from '../../shared/logging/backend-log.util';
import {
  TIP_ACTION_ROUTE_KEYS,
  TIP_ACTION_ROUTES,
} from '../../shared/tips-campaigns/tip-action-routes';
import { TIPS_CAMPAIGN_ERROR_CODES } from '../../shared/tips-campaigns/tips-campaign.errors';
import {
  TIPS_LIMITS,
  buildTipsReviewToken,
  effectiveTipsStatus,
  expiryIssue,
  nextTipsStatus,
  normalizeTipsAudience,
  normalizeTipsContent,
  parseTipsReviewToken,
  tipsEditRejection,
  validateTipsName,
  type TipsActionInput,
  type TipsAudienceInput,
  type TipsTranslationInput,
} from '../../shared/tips-campaigns/tips-campaign.policy';
import {
  TIPS_AUDIENCE_FEATURES,
  TIPS_AUDIENCE_MESSAGE_LANGUAGES,
  TIPS_AUDIENCE_PLANS,
  TIPS_AUDIENCE_PLATFORMS,
  type TipsAudience,
  type TipsCampaignAction,
  type TipsCampaignEffectiveStatus,
  type TipsCampaignStatus,
  type TipsCampaignType,
  type TipsTranslation,
  type TipsValidationIssue,
} from '../../shared/tips-campaigns/tips-campaign.types';
import type {
  AdminTipsCampaignCreateDto,
  AdminTipsCampaignUpdateDto,
  AdminTipsListQueryDto,
  AdminTipsOrganizationsQueryDto,
} from './dto/admin-tips-campaigns.dto';

const DEFAULT_LIST_LIMIT = 20;
const DEFAULT_ORGANIZATION_LIMIT = 25;

export interface AdminTipsCampaignView {
  id: string;
  name: string;
  type: TipsCampaignType;
  status: TipsCampaignStatus;
  effective_status: TipsCampaignEffectiveStatus;
  action: TipsCampaignAction | null;
  expires_at: string | null;
  audience: {
    mode: TipsAudience['mode'];
    filters: TipsAudience['filters'];
    selected_org_ids: string[];
    excluded_org_ids: string[];
  };
  translations: TipsTranslation[];
  revision: number;
  review: {
    revision: number;
    recipient_count: number;
    reviewed_at: string | null;
    current: boolean;
  } | null;
  published_at: string | null;
  recipient_count: number | null;
  paused_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  analytics: TipsCampaignAnalytics;
}

export interface AdminTipsOrganizationView {
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
}

function toIso(value: string | null): string | null {
  if (value === null) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : value;
}

function encodeCursor(value: Record<string, string>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeCursor(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    );
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function nameCursor(raw: string | undefined): TipsNameCursor | undefined {
  const cursor = decodeCursor(raw);
  return cursor &&
    typeof cursor.n === 'string' &&
    typeof cursor.id === 'string' &&
    UUID_PATTERN.test(cursor.id)
    ? { name: cursor.n, id: cursor.id }
    : undefined;
}

/**
 * Admin use cases for tips and updates: drafting, audience review,
 * publication and lifecycle. Rules come from `tips-campaign.policy.ts`;
 * every write and its audit row commit together in the repository.
 */
@Injectable()
export class AdminTipsCampaignsService {
  private readonly logger = new Logger(AdminTipsCampaignsService.name);

  constructor(private readonly campaigns: TipsCampaignsRepository) {}

  /** Overridable in specs so expiry rules can be tested at a fixed time. */
  protected now(): Date {
    return new Date();
  }

  async getOptions() {
    return {
      locales: INTERFACE_LOCALES,
      platforms: TIPS_AUDIENCE_PLATFORMS,
      plans: TIPS_AUDIENCE_PLANS,
      shopify_plans: BILLING_PLAN_IDS,
      message_languages: TIPS_AUDIENCE_MESSAGE_LANGUAGES,
      features: TIPS_AUDIENCE_FEATURES,
      action_routes: TIP_ACTION_ROUTE_KEYS.map((key) => ({
        key,
        modes: TIP_ACTION_ROUTES[key].modes,
      })),
      countries: await this.campaigns.countryOptions(),
      limits: TIPS_LIMITS,
    };
  }

  async list(query: AdminTipsListQueryDto) {
    const limit = query.limit ?? DEFAULT_LIST_LIMIT;
    const cursor = decodeCursor(query.cursor);
    const rows = await this.campaigns.listPage({
      status: query.status,
      search: query.search,
      cursor:
        cursor &&
        typeof cursor.c === 'string' &&
        typeof cursor.id === 'string' &&
        UUID_PATTERN.test(cursor.id) &&
        Number.isFinite(Date.parse(cursor.c))
          ? { createdAt: cursor.c, id: cursor.id }
          : undefined,
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const now = this.now();
    return {
      items: page.map((row) => ({
        id: row.id,
        name: row.name,
        type: row.type,
        status: row.status,
        effective_status: effectiveTipsStatus(
          row.status,
          row.expires_at ? new Date(row.expires_at) : null,
          now,
        ),
        has_action: row.action_kind !== null,
        published_at: row.published_at,
        expires_at: row.expires_at,
        created_at: row.created_at,
        recipient_count: row.recipient_count,
        analytics: {
          recipients: row.recipients,
          viewed: row.viewed,
          clicked: row.clicked,
          dismissed: row.dismissed,
        },
      })),
      next_cursor:
        rows.length > limit && last
          ? encodeCursor({ c: last.created_at, id: last.id })
          : null,
    };
  }

  async searchOrganizations(query: AdminTipsOrganizationsQueryDto) {
    const limit = query.limit ?? DEFAULT_ORGANIZATION_LIMIT;
    const rows = await this.campaigns.searchOrganizations({
      search: query.search,
      cursor: nameCursor(query.cursor),
      limit: limit + 1,
    });
    return this.organizationPage(rows, limit);
  }

  async get(id: string): Promise<AdminTipsCampaignView> {
    return this.view(await this.require(id));
  }

  async create(
    audit: TipsAdminAudit,
    dto: AdminTipsCampaignCreateDto,
  ): Promise<AdminTipsCampaignView> {
    const issues: TipsValidationIssue[] = [];
    const name = validateTipsName(dto.name);
    const content = normalizeTipsContent({
      translations: dto.translations as TipsTranslationInput[],
      action: dto.action as TipsActionInput | null | undefined,
    });
    const audience = normalizeTipsAudience(
      (dto.audience ?? {}) as TipsAudienceInput,
    );
    const expiresAt = this.normalizeExpiry(dto.expires_at, issues);
    issues.push(...name.issues, ...content.issues, ...audience.issues);
    this.assertValid(issues);

    const campaign = await this.campaigns.create(
      {
        name: name.name,
        type: dto.type,
        action: content.action,
        translations: content.translations,
        expiresAt,
        audience: audience.audience,
      },
      audit,
    );
    return this.get(campaign.id);
  }

  /**
   * Drafts change freely. Once published only content changes: an audience
   * or expiry that differs from the stored one is refused, while the same
   * values sent back by a whole-form editor are accepted.
   */
  async update(
    audit: TipsAdminAudit,
    id: string,
    dto: AdminTipsCampaignUpdateDto,
  ): Promise<AdminTipsCampaignView> {
    const { campaign, translations } = await this.require(id);
    const issues: TipsValidationIssue[] = [];
    const patch: TipsCampaignPatch = {};

    if (dto.name !== undefined) {
      const name = validateTipsName(dto.name);
      issues.push(...name.issues);
      patch.name = name.name;
    }
    if (dto.type !== undefined) patch.type = dto.type;

    if (dto.translations !== undefined || dto.action !== undefined) {
      const content = normalizeTipsContent({
        translations:
          (dto.translations as TipsTranslationInput[] | undefined) ??
          translations.map((row) => ({
            locale: row.locale,
            title: row.title,
            description: row.description,
            action_label: row.actionLabel,
          })),
        action:
          dto.action !== undefined
            ? (dto.action as TipsActionInput | null)
            : this.storedAction(campaign),
      });
      issues.push(...content.issues);
      patch.translations = content.translations;
      patch.action = content.action;
    }

    let touchesExpiry = false;
    if (dto.expires_at !== undefined) {
      const expiresAt = this.normalizeExpiry(dto.expires_at, issues, {
        allowPast: campaign.status !== 'draft',
      });
      touchesExpiry = !this.sameInstant(expiresAt, campaign.expiresAt);
      if (touchesExpiry) patch.expiresAt = expiresAt;
    }

    let touchesAudience = false;
    if (dto.audience !== undefined) {
      const audience = normalizeTipsAudience(dto.audience as TipsAudienceInput);
      issues.push(...audience.issues);
      touchesAudience =
        JSON.stringify(audience.audience) !==
        JSON.stringify(this.campaigns.audienceFromRecord(campaign));
      if (touchesAudience) patch.audience = audience.audience;
    }

    const rejection = tipsEditRejection(campaign.status, {
      touchesAudience,
      touchesExpiry,
    });
    if (rejection) throw this.conflict(rejection, this.editMessage(rejection));
    this.assertValid(issues);

    const outcome = await this.campaigns.update(id, dto.revision, patch, audit);
    if (outcome.kind === 'not_found') throw this.notFound();
    if (outcome.kind === 'revision_conflict')
      throw this.conflict(
        TIPS_CAMPAIGN_ERROR_CODES.revisionConflict,
        'This campaign was changed by someone else. Reload it and try again.',
      );
    return this.get(id);
  }

  /**
   * Computes the audience as it stands and records it against the current
   * revision. The returned token is what publication must present.
   */
  async review(audit: TipsAdminAudit, id: string) {
    const detail = await this.require(id);
    const { campaign } = detail;
    if (campaign.status !== 'draft')
      throw this.conflict(
        TIPS_CAMPAIGN_ERROR_CODES.invalidTransition,
        'Only a draft can be reviewed for publication.',
      );
    this.assertValid(this.publicationIssues(detail));

    const summary = await this.campaigns.summarizeAudience(
      this.campaigns.audienceFromRecord(campaign),
    );
    if (summary.count === 0)
      throw this.conflict(
        TIPS_CAMPAIGN_ERROR_CODES.noRecipients,
        'No merchant matches this audience.',
      );
    if (summary.count > TIPS_LIMITS.maxRecipients)
      throw this.conflict(
        TIPS_CAMPAIGN_ERROR_CODES.audienceTooLarge,
        'This audience is larger than one campaign may reach.',
        { recipient_count: summary.count },
      );
    const saved = await this.campaigns.saveReview(
      id,
      campaign.revision,
      summary,
      audit.userId,
    );
    if (!saved)
      throw this.conflict(
        TIPS_CAMPAIGN_ERROR_CODES.revisionConflict,
        'This campaign was changed while it was being reviewed.',
      );
    return {
      review_token: buildTipsReviewToken(campaign.revision, summary.hash),
      recipient_count: summary.count,
      campaign: await this.get(id),
    };
  }

  async publish(
    audit: TipsAdminAudit,
    id: string,
    reviewToken: string,
  ): Promise<AdminTipsCampaignView & { already_published: boolean }> {
    const detail = await this.require(id);
    const { campaign } = detail;
    const token = parseTipsReviewToken(reviewToken);

    if (campaign.status === 'draft') {
      if (
        !token ||
        token.revision !== campaign.revision ||
        campaign.reviewedRevision !== token.revision ||
        campaign.reviewedAudienceHash !== token.hash
      ) {
        throw this.conflict(
          TIPS_CAMPAIGN_ERROR_CODES.reviewRequired,
          'Review the audience again before publishing.',
        );
      }
      this.assertValid(this.publicationIssues(detail));
    }

    const outcome = await this.campaigns.publish({
      id,
      revision: token?.revision ?? campaign.revision,
      reviewedHash: token?.hash ?? '',
      token: reviewToken,
      maxRecipients: TIPS_LIMITS.maxRecipients,
      audit,
    });
    this.logger.log(
      buildBackendLog(AdminTipsCampaignsService.name, {
        action: 'admin-tips-campaign-publish',
        outcome: outcome.kind === 'published' ? 'success' : 'skipped',
        result: outcome.kind,
        campaignId: id,
      }),
    );
    switch (outcome.kind) {
      case 'published':
        return { ...(await this.get(id)), already_published: false };
      case 'already_published':
        return { ...(await this.get(id)), already_published: true };
      case 'not_found':
        throw this.notFound();
      case 'not_draft':
        throw this.conflict(
          TIPS_CAMPAIGN_ERROR_CODES.invalidTransition,
          'This campaign is no longer a draft.',
        );
      case 'revision_mismatch':
        throw this.conflict(
          TIPS_CAMPAIGN_ERROR_CODES.reviewRequired,
          'Review the audience again before publishing.',
        );
      case 'expired':
        throw this.invalid([{ field: 'expires_at', code: 'expiry_in_past' }]);
      case 'no_recipients':
        throw this.conflict(
          TIPS_CAMPAIGN_ERROR_CODES.noRecipients,
          'No merchant matches this audience.',
        );
      case 'too_large':
        throw this.conflict(
          TIPS_CAMPAIGN_ERROR_CODES.audienceTooLarge,
          'This audience is larger than one campaign may reach.',
          { recipient_count: outcome.count },
        );
      case 'audience_changed':
        throw this.conflict(
          TIPS_CAMPAIGN_ERROR_CODES.audienceChanged,
          'The audience changed since it was reviewed. Review it again.',
          { recipient_count: outcome.count },
        );
    }
  }

  async changeLifecycle(
    audit: TipsAdminAudit,
    id: string,
    action: 'pause' | 'resume' | 'archive',
  ): Promise<AdminTipsCampaignView> {
    const { campaign } = await this.require(id);
    const decision = nextTipsStatus(
      action,
      campaign.status,
      campaign.expiresAt ? new Date(campaign.expiresAt) : null,
      this.now(),
    );
    if (decision.kind === 'unchanged') return this.get(id);
    if (decision.kind === 'rejected')
      throw this.conflict(decision.code, this.transitionMessage(decision.code));
    const outcome = await this.campaigns.transition({
      id,
      from: campaign.status,
      next: decision.next,
      action,
      audit,
    });
    if (outcome.kind === 'not_found') throw this.notFound();
    if (outcome.kind === 'state_changed')
      throw this.conflict(
        TIPS_CAMPAIGN_ERROR_CODES.revisionConflict,
        'This campaign was changed by someone else. Reload it and try again.',
      );
    return this.get(id);
  }

  /**
   * A draft lists its live audience with exclusions flagged; a published
   * campaign lists its frozen recipients with their first events.
   */
  async recipients(id: string, query: AdminTipsOrganizationsQueryDto) {
    const { campaign } = await this.require(id);
    const limit = query.limit ?? DEFAULT_ORGANIZATION_LIMIT;
    const page = {
      search: query.search,
      cursor: nameCursor(query.cursor),
      limit: limit + 1,
    };
    const rows =
      campaign.status === 'draft'
        ? await this.campaigns.pageAudience(
            this.campaigns.audienceFromRecord(campaign),
            page,
            true,
          )
        : await this.campaigns.pageRecipients(id, page);
    return this.organizationPage(rows, limit);
  }

  private organizationPage(
    rows: (TipsAudienceOrganizationRow & { sort_name?: string })[],
    limit: number,
  ) {
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(
        (row): AdminTipsOrganizationView => ({
          org_id: row.org_id,
          organization_name: row.organization_name,
          store_name: row.store_name,
          shop_domain: row.shop_domain,
          platform: row.platform,
          country_code: row.country_code,
          excluded: row.excluded === true,
          first_viewed_at: row.first_viewed_at,
          first_clicked_at: row.first_clicked_at,
          dismissed_at: row.dismissed_at,
        }),
      ),
      next_cursor:
        rows.length > limit && last
          ? encodeCursor({ n: last.sort_name ?? '', id: last.org_id })
          : null,
    };
  }

  private publicationIssues(detail: TipsCampaignDetail): TipsValidationIssue[] {
    const { campaign, translations } = detail;
    const content = normalizeTipsContent({
      translations: translations.map((row) => ({
        locale: row.locale,
        title: row.title,
        description: row.description,
        action_label: row.actionLabel,
      })),
      action: this.storedAction(campaign),
    });
    const expiry = expiryIssue(campaign.expiresAt, this.now());
    return [
      ...validateTipsName(campaign.name).issues,
      ...content.issues,
      ...(expiry ? [expiry] : []),
    ];
  }

  private storedAction(campaign: TipsCampaignRecord): TipsActionInput | null {
    if (campaign.actionKind === 'internal')
      return { kind: 'internal', route: campaign.actionRoute };
    if (campaign.actionKind === 'external')
      return { kind: 'external', url: campaign.actionUrl };
    return null;
  }

  private normalizeExpiry(
    value: string | null | undefined,
    issues: TipsValidationIssue[],
    options: { allowPast?: boolean } = {},
  ): string | null {
    if (value === null || value === undefined || value === '') return null;
    const issue = expiryIssue(value, this.now());
    if (issue && !(options.allowPast && issue.code === 'expiry_in_past')) {
      issues.push(issue);
      return null;
    }
    return new Date(value).toISOString();
  }

  private sameInstant(a: string | null, b: string | null): boolean {
    if (a === null || b === null) return a === b;
    return Date.parse(a) === Date.parse(b);
  }

  private async view(
    detail: TipsCampaignDetail,
  ): Promise<AdminTipsCampaignView> {
    const { campaign, translations } = detail;
    const analytics = await this.campaigns.analytics(campaign.id);
    const stored = this.storedAction(campaign);
    const action: TipsCampaignAction | null =
      stored?.kind === 'internal'
        ? ({
            kind: 'internal',
            route: campaign.actionRoute,
          } as TipsCampaignAction)
        : stored?.kind === 'external'
          ? { kind: 'external', url: campaign.actionUrl ?? '' }
          : null;
    const audience = this.campaigns.audienceFromRecord(campaign);
    return {
      id: campaign.id,
      name: campaign.name,
      type: campaign.type,
      status: campaign.status,
      effective_status: effectiveTipsStatus(
        campaign.status,
        campaign.expiresAt ? new Date(campaign.expiresAt) : null,
        this.now(),
      ),
      action,
      expires_at: toIso(campaign.expiresAt),
      audience: {
        mode: audience.mode,
        filters: audience.filters,
        selected_org_ids: audience.selectedOrgIds,
        excluded_org_ids: audience.excludedOrgIds,
      },
      translations: INTERFACE_LOCALES.flatMap((locale) => {
        const row = translations.find(
          (candidate) => candidate.locale === locale,
        );
        return row
          ? [
              {
                locale,
                title: row.title,
                description: row.description,
                action_label: row.actionLabel,
              },
            ]
          : [];
      }),
      revision: campaign.revision,
      review:
        campaign.reviewedRevision !== null &&
        campaign.reviewedRecipientCount !== null
          ? {
              revision: campaign.reviewedRevision,
              recipient_count: campaign.reviewedRecipientCount,
              reviewed_at: toIso(campaign.reviewedAt),
              current: campaign.reviewedRevision === campaign.revision,
            }
          : null,
      published_at: toIso(campaign.publishedAt),
      recipient_count: campaign.recipientCount,
      paused_at: toIso(campaign.pausedAt),
      archived_at: toIso(campaign.archivedAt),
      created_at: toIso(campaign.createdAt) ?? campaign.createdAt,
      updated_at: toIso(campaign.updatedAt) ?? campaign.updatedAt,
      analytics,
    };
  }

  private async require(id: string): Promise<TipsCampaignDetail> {
    const detail = await this.campaigns.findById(id);
    if (!detail) throw this.notFound();
    return detail;
  }

  private assertValid(issues: TipsValidationIssue[]): void {
    if (issues.length) throw this.invalid(issues);
  }

  private invalid(issues: TipsValidationIssue[]) {
    return new UnprocessableEntityException({
      statusCode: 422,
      error: 'Unprocessable Entity',
      message: 'The campaign does not pass validation.',
      code: TIPS_CAMPAIGN_ERROR_CODES.invalid,
      issues,
    });
  }

  private notFound() {
    return new NotFoundException({
      statusCode: 404,
      error: 'Not Found',
      message: 'Campaign not found.',
      code: TIPS_CAMPAIGN_ERROR_CODES.notFound,
    });
  }

  private conflict(
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    return new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      message,
      code,
      ...details,
    });
  }

  private editMessage(code: string): string {
    switch (code) {
      case TIPS_CAMPAIGN_ERROR_CODES.audienceLocked:
        return 'The audience of a published campaign cannot change. Publish a new campaign instead.';
      case TIPS_CAMPAIGN_ERROR_CODES.expiryLocked:
        return 'The expiry of a published campaign cannot change.';
      default:
        return 'An archived campaign is read-only.';
    }
  }

  private transitionMessage(code: string): string {
    return code === TIPS_CAMPAIGN_ERROR_CODES.expired
      ? 'This campaign has expired. Archive it and publish a new one.'
      : 'This campaign cannot make that change in its current state.';
  }
}
