import {
  FALLBACK_INTERFACE_LOCALE,
  INTERFACE_LOCALES,
  isInterfaceLocale,
  type InterfaceLocale,
} from '../i18n/interface-locales';
import { isTipActionRoute } from './tip-action-routes';
import { TIPS_CAMPAIGN_ERROR_CODES } from './tips-campaign.errors';
import {
  TIPS_AUDIENCE_FEATURES,
  TIPS_AUDIENCE_MESSAGE_LANGUAGES,
  TIPS_AUDIENCE_PLANS,
  TIPS_AUDIENCE_PLATFORMS,
  type TipsAudience,
  type TipsAudienceFeature,
  type TipsAudienceFilters,
  type TipsCampaignAction,
  type TipsCampaignEffectiveStatus,
  type TipsCampaignStatus,
  type TipsLifecycleAction,
  type TipsTargetingMode,
  type TipsTranslation,
  type TipsValidationIssue,
} from './tips-campaign.types';

export const TIPS_LIMITS = {
  name: 120,
  title: 80,
  titleLineBreaks: 1,
  description: 500,
  descriptionLineBreaks: 8,
  actionLabel: 30,
  url: 2048,
  /** Direct selection and exclusions are hand-picked lists, so they stay short. */
  orgList: 500,
  countries: 250,
  /** Publication inserts the snapshot in one transaction; beyond this, split it. */
  maxRecipients: 50_000,
  /** Cards a merchant dashboard receives at most. */
  merchantCards: 20,
} as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const COUNTRY_PATTERN = /^[A-Z]{2}$/;
const REVIEW_TOKEN_PATTERN = /^(\d{1,9})\.([0-9a-f]{64})$/;

/** Plain text: CRLF becomes LF and the ends are trimmed. */
export function normalizeTipText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : '';
}

/** Control characters other than a line break have no place in card text. */
function hasControlCharacter(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if ((code < 0x20 && code !== 0x0a) || code === 0x7f) return true;
  }
  return false;
}

function lineBreaks(text: string): number {
  return text.split('\n').length - 1;
}

function textIssues(
  field: string,
  text: string,
  max: number,
  maxLineBreaks: number,
  locale?: string,
): TipsValidationIssue[] {
  const at = locale ? { locale } : {};
  if (!text) return [{ field, code: 'required', ...at }];
  if (hasControlCharacter(text))
    return [{ field, code: 'control_character', ...at }];
  if ([...text].length > max) return [{ field, code: 'too_long', ...at }];
  if (lineBreaks(text) > maxLineBreaks)
    return [{ field, code: 'too_many_lines', ...at }];
  return [];
}

export function validateTipsName(value: unknown): {
  name: string;
  issues: TipsValidationIssue[];
} {
  const name = normalizeTipText(value);
  return { name, issues: textIssues('name', name, TIPS_LIMITS.name, 0) };
}

/**
 * Only absolute HTTPS links to a public host. Checking the raw prefix first
 * rejects `javascript:`, `data:` and protocol-relative links before parsing.
 */
export function externalUrlIssue(raw: string): string | null {
  if (raw.length > TIPS_LIMITS.url) return 'url_too_long';
  if (!raw.toLowerCase().startsWith('https://')) return 'url_not_https';
  if (/\s/.test(raw)) return 'invalid_url';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'invalid_url';
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    !host.includes('.') ||
    host === 'localhost' ||
    host.endsWith('.localhost')
  ) {
    return 'invalid_url';
  }
  return null;
}

export interface TipsActionInput {
  kind?: unknown;
  route?: unknown;
  url?: unknown;
}

export function normalizeTipsAction(
  input: TipsActionInput | null | undefined,
): {
  action: TipsCampaignAction | null;
  issues: TipsValidationIssue[];
} {
  if (!input) return { action: null, issues: [] };
  if (input.kind === 'internal') {
    const route = typeof input.route === 'string' ? input.route.trim() : '';
    return isTipActionRoute(route)
      ? { action: { kind: 'internal', route }, issues: [] }
      : {
          action: null,
          issues: [{ field: 'action.route', code: 'invalid_route' }],
        };
  }
  if (input.kind === 'external') {
    const url = typeof input.url === 'string' ? input.url.trim() : '';
    const code = url ? externalUrlIssue(url) : 'required';
    return code
      ? { action: null, issues: [{ field: 'action.url', code }] }
      : { action: { kind: 'external', url }, issues: [] };
  }
  return {
    action: null,
    issues: [{ field: 'action.kind', code: 'invalid_value' }],
  };
}

export interface TipsTranslationInput {
  locale?: unknown;
  title?: unknown;
  description?: unknown;
  action_label?: unknown;
}

/**
 * English must be complete; any other locale is complete or absent. With a
 * button, every bundle carries its label, so a card never mixes languages.
 */
export function normalizeTipsTranslations(
  inputs: readonly TipsTranslationInput[],
  hasAction: boolean,
): { translations: TipsTranslation[]; issues: TipsValidationIssue[] } {
  const issues: TipsValidationIssue[] = [];
  const byLocale = new Map<InterfaceLocale, TipsTranslation>();
  for (const input of inputs) {
    if (!isInterfaceLocale(input.locale)) {
      issues.push({ field: 'translations', code: 'unsupported_locale' });
      continue;
    }
    const locale = input.locale;
    if (byLocale.has(locale)) {
      issues.push({ field: 'translations', code: 'duplicate_locale', locale });
      continue;
    }
    const title = normalizeTipText(input.title);
    const description = normalizeTipText(input.description);
    const label = normalizeTipText(input.action_label);
    issues.push(
      ...textIssues(
        'title',
        title,
        TIPS_LIMITS.title,
        TIPS_LIMITS.titleLineBreaks,
        locale,
      ),
      ...textIssues(
        'description',
        description,
        TIPS_LIMITS.description,
        TIPS_LIMITS.descriptionLineBreaks,
        locale,
      ),
    );
    if (hasAction) {
      issues.push(
        ...textIssues(
          'action_label',
          label,
          TIPS_LIMITS.actionLabel,
          0,
          locale,
        ),
      );
    }
    byLocale.set(locale, {
      locale,
      title,
      description,
      action_label: hasAction ? label : null,
    });
  }
  if (!byLocale.has(FALLBACK_INTERFACE_LOCALE)) {
    issues.push({
      field: 'translations',
      code: 'english_required',
      locale: FALLBACK_INTERFACE_LOCALE,
    });
  }
  const translations = INTERFACE_LOCALES.flatMap((locale) => {
    const row = byLocale.get(locale);
    return row ? [row] : [];
  });
  return { translations, issues };
}

export interface TipsContentInput {
  translations: readonly TipsTranslationInput[];
  action: TipsActionInput | null | undefined;
}

export function normalizeTipsContent(input: TipsContentInput): {
  translations: TipsTranslation[];
  action: TipsCampaignAction | null;
  issues: TipsValidationIssue[];
} {
  const action = normalizeTipsAction(input.action);
  const hasAction = !!input.action;
  const content = normalizeTipsTranslations(input.translations, hasAction);
  return {
    translations: content.translations,
    action: action.action,
    issues: [...action.issues, ...content.issues],
  };
}

/** The expiry, when set, must be a valid instant still ahead of `now`. */
export function expiryIssue(
  expiresAt: string | null | undefined,
  now: Date,
): TipsValidationIssue | null {
  if (expiresAt === null || expiresAt === undefined) return null;
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at))
    return { field: 'expires_at', code: 'invalid_value' };
  return at <= now.getTime()
    ? { field: 'expires_at', code: 'expiry_in_past' }
    : null;
}

function isUtcDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.toISOString().slice(0, 10) === value;
}

function pickFromCatalog<T extends string>(
  field: string,
  values: unknown,
  catalog: readonly T[],
  issues: TipsValidationIssue[],
): T[] | undefined {
  if (values === undefined || values === null) return undefined;
  if (!Array.isArray(values)) {
    issues.push({ field, code: 'invalid_value' });
    return undefined;
  }
  const chosen = new Set<T>();
  for (const value of values) {
    if (catalog.includes(value as T)) chosen.add(value as T);
    else issues.push({ field, code: 'invalid_value' });
  }
  const ordered = catalog.filter((value) => chosen.has(value));
  return ordered.length ? ordered : undefined;
}

/**
 * Normalizes filters into one canonical shape (sorted, deduplicated, empty
 * filters dropped), so the stored criteria and the audience query agree.
 */
export function normalizeTipsAudienceFilters(raw: unknown): {
  filters: TipsAudienceFilters;
  issues: TipsValidationIssue[];
} {
  const issues: TipsValidationIssue[] = [];
  const filters: TipsAudienceFilters = {};
  if (raw === undefined || raw === null) return { filters, issues };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { filters, issues: [{ field: 'filters', code: 'invalid_value' }] };
  }
  const input = raw as Record<string, unknown>;

  if (input.countries !== undefined && input.countries !== null) {
    if (!Array.isArray(input.countries)) {
      issues.push({ field: 'filters.countries', code: 'invalid_value' });
    } else {
      const countries = new Set<string>();
      for (const value of input.countries) {
        const code =
          typeof value === 'string' ? value.trim().toUpperCase() : '';
        if (COUNTRY_PATTERN.test(code)) countries.add(code);
        else issues.push({ field: 'filters.countries', code: 'invalid_value' });
      }
      if (countries.size > TIPS_LIMITS.countries) {
        issues.push({ field: 'filters.countries', code: 'too_many' });
      } else if (countries.size) {
        filters.countries = [...countries].sort();
      }
    }
  }

  const platforms = pickFromCatalog(
    'filters.platforms',
    input.platforms,
    TIPS_AUDIENCE_PLATFORMS,
    issues,
  );
  if (platforms) filters.platforms = platforms;

  for (const key of ['signup_from', 'signup_to'] as const) {
    const value = input[key];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'string' && isUtcDate(value)) filters[key] = value;
    else issues.push({ field: `filters.${key}`, code: 'invalid_date' });
  }
  if (
    filters.signup_from &&
    filters.signup_to &&
    filters.signup_from > filters.signup_to
  ) {
    issues.push({ field: 'filters.signup_to', code: 'date_order' });
  }

  const languages = pickFromCatalog(
    'filters.message_languages',
    input.message_languages,
    TIPS_AUDIENCE_MESSAGE_LANGUAGES,
    issues,
  );
  if (languages) filters.message_languages = languages;

  const plans = pickFromCatalog(
    'filters.plans',
    input.plans,
    TIPS_AUDIENCE_PLANS,
    issues,
  );
  if (plans) filters.plans = plans;

  if (input.features !== undefined && input.features !== null) {
    if (typeof input.features !== 'object' || Array.isArray(input.features)) {
      issues.push({ field: 'filters.features', code: 'invalid_value' });
    } else {
      const raw = input.features as Record<string, unknown>;
      const features: Partial<Record<TipsAudienceFeature, boolean>> = {};
      for (const [key, value] of Object.entries(raw)) {
        if (
          TIPS_AUDIENCE_FEATURES.includes(key as TipsAudienceFeature) &&
          typeof value === 'boolean'
        ) {
          features[key as TipsAudienceFeature] = value;
        } else {
          issues.push({ field: 'filters.features', code: 'invalid_value' });
        }
      }
      const ordered = TIPS_AUDIENCE_FEATURES.filter(
        (key) => features[key] !== undefined,
      );
      if (ordered.length) {
        filters.features = Object.fromEntries(
          ordered.map((key) => [key, features[key]]),
        );
      }
    }
  }

  return { filters, issues };
}

export function normalizeTipsOrgIds(
  field: string,
  raw: unknown,
): { ids: string[]; issues: TipsValidationIssue[] } {
  if (raw === undefined || raw === null) return { ids: [], issues: [] };
  if (!Array.isArray(raw)) {
    return { ids: [], issues: [{ field, code: 'invalid_value' }] };
  }
  const ids = new Set<string>();
  const issues: TipsValidationIssue[] = [];
  for (const value of raw) {
    const id = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (UUID_PATTERN.test(id)) ids.add(id);
    else issues.push({ field, code: 'invalid_value' });
  }
  if (ids.size > TIPS_LIMITS.orgList) issues.push({ field, code: 'too_many' });
  return { ids: [...ids].sort(), issues };
}

export interface TipsAudienceInput {
  mode?: unknown;
  filters?: unknown;
  selected_org_ids?: unknown;
  excluded_org_ids?: unknown;
}

export function normalizeTipsAudience(input: TipsAudienceInput): {
  audience: TipsAudience;
  issues: TipsValidationIssue[];
} {
  const issues: TipsValidationIssue[] = [];
  let mode: TipsTargetingMode = 'filters';
  if (input.mode === 'direct' || input.mode === 'filters') mode = input.mode;
  else if (input.mode !== undefined)
    issues.push({ field: 'mode', code: 'invalid_value' });
  const filters = normalizeTipsAudienceFilters(input.filters);
  const selected = normalizeTipsOrgIds(
    'selected_org_ids',
    input.selected_org_ids,
  );
  const excluded = normalizeTipsOrgIds(
    'excluded_org_ids',
    input.excluded_org_ids,
  );
  issues.push(...filters.issues, ...selected.issues, ...excluded.issues);
  return {
    audience: {
      mode,
      filters: filters.filters,
      selectedOrgIds: selected.ids,
      excludedOrgIds: excluded.ids,
    },
    issues,
  };
}

export function isTipsCampaignExpired(
  expiresAt: Date | null,
  now: Date,
): boolean {
  return expiresAt !== null && expiresAt.getTime() <= now.getTime();
}

/** What admins see: a published or paused campaign past its expiry is expired. */
export function effectiveTipsStatus(
  status: TipsCampaignStatus,
  expiresAt: Date | null,
  now: Date,
): TipsCampaignEffectiveStatus {
  if (
    (status === 'published' || status === 'paused') &&
    isTipsCampaignExpired(expiresAt, now)
  ) {
    return 'expired';
  }
  return status;
}

export type TipsTransitionResult =
  | { kind: 'change'; next: TipsCampaignStatus }
  | { kind: 'unchanged' }
  | { kind: 'rejected'; code: string };

/**
 * Lifecycle rules. A repeat of the action that already holds is a no-op, so
 * retries are safe. An expired campaign can only be archived: resuming it
 * would silently extend its life.
 */
export function nextTipsStatus(
  action: Exclude<TipsLifecycleAction, 'publish'>,
  status: TipsCampaignStatus,
  expiresAt: Date | null,
  now: Date,
): TipsTransitionResult {
  const expired = isTipsCampaignExpired(expiresAt, now);
  const rejected = (code: string): TipsTransitionResult => ({
    kind: 'rejected',
    code,
  });
  switch (action) {
    case 'archive':
      return status === 'archived'
        ? { kind: 'unchanged' }
        : { kind: 'change', next: 'archived' };
    case 'pause':
      if (status === 'paused') return { kind: 'unchanged' };
      if (status !== 'published')
        return rejected(TIPS_CAMPAIGN_ERROR_CODES.invalidTransition);
      return expired
        ? rejected(TIPS_CAMPAIGN_ERROR_CODES.expired)
        : { kind: 'change', next: 'paused' };
    case 'resume':
      if (status !== 'paused' && status !== 'published')
        return rejected(TIPS_CAMPAIGN_ERROR_CODES.invalidTransition);
      if (expired) return rejected(TIPS_CAMPAIGN_ERROR_CODES.expired);
      return status === 'published'
        ? { kind: 'unchanged' }
        : { kind: 'change', next: 'published' };
  }
}

export interface TipsCampaignPatchShape {
  touchesAudience: boolean;
  touchesExpiry: boolean;
}

/**
 * What an edit may change in each state. After publication only content
 * (name, type, translations, button) changes; the frozen audience and the
 * configured expiry stay as published.
 */
export function tipsEditRejection(
  status: TipsCampaignStatus,
  patch: TipsCampaignPatchShape,
): string | null {
  if (status === 'archived') return TIPS_CAMPAIGN_ERROR_CODES.notEditable;
  if (status === 'draft') return null;
  if (patch.touchesAudience) return TIPS_CAMPAIGN_ERROR_CODES.audienceLocked;
  if (patch.touchesExpiry) return TIPS_CAMPAIGN_ERROR_CODES.expiryLocked;
  return null;
}

/**
 * The bundle a merchant reads: their locale when it is complete for this
 * campaign, otherwise English, whole. A title is never shown in one language
 * with the body or button in another.
 */
export function chooseTipsBundle<T extends TipsTranslation>(
  translations: readonly T[],
  locale: InterfaceLocale,
  hasAction: boolean,
): T | null {
  const complete = (row: T | undefined): row is T =>
    !!row &&
    !!row.title &&
    !!row.description &&
    (!hasAction || !!row.action_label);
  const requested = translations.find((row) => row.locale === locale);
  if (complete(requested)) return requested;
  const fallback = translations.find(
    (row) => row.locale === FALLBACK_INTERFACE_LOCALE,
  );
  return complete(fallback) ? fallback : null;
}

export function buildTipsReviewToken(revision: number, hash: string): string {
  return `${revision}.${hash}`;
}

export function parseTipsReviewToken(
  token: unknown,
): { revision: number; hash: string } | null {
  if (typeof token !== 'string') return null;
  const match = REVIEW_TOKEN_PATTERN.exec(token);
  return match ? { revision: Number(match[1]), hash: match[2] } : null;
}
