import {
  buildTipsReviewToken,
  chooseTipsBundle,
  effectiveTipsStatus,
  expiryIssue,
  externalUrlIssue,
  nextTipsStatus,
  normalizeTipText,
  normalizeTipsAudience,
  normalizeTipsAudienceFilters,
  normalizeTipsContent,
  normalizeTipsOrgIds,
  parseTipsReviewToken,
  tipsEditRejection,
  validateTipsName,
} from './tips-campaign.policy';
import type { TipsTranslation } from './tips-campaign.types';

const now = new Date('2026-10-25T12:00:00.000Z');
const later = new Date('2026-11-01T00:00:00.000Z');
const earlier = new Date('2026-10-01T00:00:00.000Z');

const en = {
  locale: 'en',
  title: 'Quiet hours',
  description: 'Hold sends\nat night.',
};

describe('normalizeTipText', () => {
  it('turns CRLF into LF and trims the ends', () => {
    expect(normalizeTipText('  a\r\nb\rc  ')).toBe('a\nb\nc');
    expect(normalizeTipText(42)).toBe('');
  });
});

describe('validateTipsName', () => {
  it.each([
    ['', 'required'],
    ['x'.repeat(121), 'too_long'],
    ['two\nlines', 'too_many_lines'],
    [`tab${String.fromCharCode(9)}here`, 'control_character'],
  ])('rejects %j as %s', (value, code) => {
    expect(validateTipsName(value).issues).toEqual([{ field: 'name', code }]);
  });

  it('accepts a normal name', () => {
    expect(validateTipsName(' Quiet hours tip ')).toEqual({
      name: 'Quiet hours tip',
      issues: [],
    });
  });
});

describe('externalUrlIssue', () => {
  it.each([
    ['javascript:alert(1)', 'url_not_https'],
    ['data:text/html,hi', 'url_not_https'],
    ['//evil.example.com/x', 'url_not_https'],
    ['http://example.com', 'url_not_https'],
    ['https://user:pw@example.com', 'invalid_url'],
    ['https://localhost/x', 'invalid_url'],
    ['https://intranet/x', 'invalid_url'],
    ['https://exa mple.com', 'invalid_url'],
    ['https://', 'invalid_url'],
    [`https://example.com/${'a'.repeat(2048)}`, 'url_too_long'],
  ])('rejects %s', (url, code) => {
    expect(externalUrlIssue(url)).toBe(code);
  });

  it('accepts an absolute HTTPS link', () => {
    expect(
      externalUrlIssue('https://akeed.app/docs/quiet-hours?x=1'),
    ).toBeNull();
    expect(externalUrlIssue('HTTPS://Example.com')).toBeNull();
  });
});

describe('normalizeTipsContent', () => {
  it('requires complete English content', () => {
    const { issues } = normalizeTipsContent({
      translations: [
        { locale: 'ar', title: 'ساعات الهدوء', description: 'نص' },
      ],
      action: null,
    });
    expect(issues).toContainEqual({
      field: 'translations',
      code: 'english_required',
      locale: 'en',
    });
  });

  it('rejects a partial translation instead of mixing languages', () => {
    const { issues } = normalizeTipsContent({
      translations: [
        en,
        { locale: 'ar', title: 'ساعات الهدوء', description: '' },
      ],
      action: null,
    });
    expect(issues).toEqual([
      { field: 'description', code: 'required', locale: 'ar' },
    ]);
  });

  it('enforces limits and line breaks', () => {
    const { issues } = normalizeTipsContent({
      translations: [
        {
          locale: 'en',
          title: 'a\nb\nc',
          description: 'x'.repeat(501),
        },
      ],
      action: null,
    });
    expect(issues).toEqual([
      { field: 'title', code: 'too_many_lines', locale: 'en' },
      { field: 'description', code: 'too_long', locale: 'en' },
    ]);
  });

  it('rejects unsupported and duplicate locales', () => {
    const { issues } = normalizeTipsContent({
      translations: [
        en,
        { ...en },
        { locale: 'de', title: 't', description: 'd' },
      ],
      action: null,
    });
    expect(issues).toEqual([
      { field: 'translations', code: 'duplicate_locale', locale: 'en' },
      { field: 'translations', code: 'unsupported_locale' },
    ]);
  });

  it('requires a label in every bundle when there is a button', () => {
    const { issues, action } = normalizeTipsContent({
      translations: [
        { ...en, action_label: 'Open settings' },
        { locale: 'ar', title: 'ساعات الهدوء', description: 'نص' },
      ],
      action: { kind: 'internal', route: 'settings_timing' },
    });
    expect(action).toEqual({ kind: 'internal', route: 'settings_timing' });
    expect(issues).toEqual([
      { field: 'action_label', code: 'required', locale: 'ar' },
    ]);
  });

  it('drops labels when there is no button and orders locales', () => {
    const { translations, issues } = normalizeTipsContent({
      translations: [
        {
          locale: 'tr',
          title: 'Sessiz saatler',
          description: 'Metin',
          action_label: 'x',
        },
        { ...en, action_label: 'stale' },
      ],
      action: null,
    });
    expect(issues).toEqual([]);
    expect(translations.map((row) => [row.locale, row.action_label])).toEqual([
      ['en', null],
      ['tr', null],
    ]);
  });

  it('rejects an unknown internal route and an unsafe external link', () => {
    expect(
      normalizeTipsContent({
        translations: [{ ...en, action_label: 'Go' }],
        action: { kind: 'internal', route: 'admin' },
      }).issues,
    ).toEqual([{ field: 'action.route', code: 'invalid_route' }]);
    expect(
      normalizeTipsContent({
        translations: [{ ...en, action_label: 'Go' }],
        action: { kind: 'external', url: 'javascript:alert(1)' },
      }).issues,
    ).toEqual([{ field: 'action.url', code: 'url_not_https' }]);
  });
});

describe('expiryIssue', () => {
  it('allows no expiry and a future one', () => {
    expect(expiryIssue(null, now)).toBeNull();
    expect(expiryIssue(later.toISOString(), now)).toBeNull();
  });

  it('rejects a past or malformed expiry', () => {
    expect(expiryIssue(earlier.toISOString(), now)).toEqual({
      field: 'expires_at',
      code: 'expiry_in_past',
    });
    expect(expiryIssue(now.toISOString(), now)?.code).toBe('expiry_in_past');
    expect(expiryIssue('soon', now)?.code).toBe('invalid_value');
  });
});

describe('normalizeTipsAudienceFilters', () => {
  it('canonicalizes values and drops empty filters', () => {
    expect(
      normalizeTipsAudienceFilters({
        countries: ['pk', 'EG', 'pk'],
        platforms: ['woocommerce', 'shopify', 'shopify'],
        message_languages: [],
        plans: ['prepaid', 'starter'],
        signup_from: '2026-01-01',
        signup_to: '',
        features: { quiet_hours: false, auto_cancel: true },
      }),
    ).toEqual({
      filters: {
        countries: ['EG', 'PK'],
        platforms: ['shopify', 'woocommerce'],
        plans: ['starter', 'prepaid'],
        signup_from: '2026-01-01',
        features: { auto_cancel: true, quiet_hours: false },
      },
      issues: [],
    });
  });

  it('rejects values outside the catalogs', () => {
    const { issues } = normalizeTipsAudienceFilters({
      countries: ['Egypt'],
      platforms: ['salla'],
      plans: ['enterprise'],
      message_languages: ['de'],
      features: { secret_flag: true, quiet_hours: 'yes' },
      signup_from: '2026-02-30',
    });
    expect(issues.map((issue) => issue.field)).toEqual([
      'filters.countries',
      'filters.platforms',
      'filters.signup_from',
      'filters.message_languages',
      'filters.plans',
      'filters.features',
      'filters.features',
    ]);
  });

  it('rejects a reversed date range', () => {
    expect(
      normalizeTipsAudienceFilters({
        signup_from: '2026-03-01',
        signup_to: '2026-02-01',
      }).issues,
    ).toEqual([{ field: 'filters.signup_to', code: 'date_order' }]);
  });
});

describe('normalizeTipsOrgIds and normalizeTipsAudience', () => {
  const id = (n: number) =>
    `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  it('deduplicates, lowercases and sorts ids', () => {
    expect(
      normalizeTipsOrgIds('selected_org_ids', [
        id(2),
        id(1).toUpperCase(),
        id(2),
      ]),
    ).toEqual({ ids: [id(1), id(2)], issues: [] });
  });

  it('caps hand-picked lists and rejects non-uuids', () => {
    const many = Array.from({ length: 501 }, (_, n) => id(n));
    expect(normalizeTipsOrgIds('excluded_org_ids', many).issues).toEqual([
      { field: 'excluded_org_ids', code: 'too_many' },
    ]);
    expect(normalizeTipsOrgIds('selected_org_ids', ['x']).issues).toEqual([
      { field: 'selected_org_ids', code: 'invalid_value' },
    ]);
  });

  it('defaults to filters mode', () => {
    expect(normalizeTipsAudience({}).audience).toEqual({
      mode: 'filters',
      filters: {},
      selectedOrgIds: [],
      excludedOrgIds: [],
    });
    expect(normalizeTipsAudience({ mode: 'everyone' }).issues).toEqual([
      { field: 'mode', code: 'invalid_value' },
    ]);
  });
});

describe('lifecycle', () => {
  it('derives expired for published and paused campaigns only', () => {
    expect(effectiveTipsStatus('published', earlier, now)).toBe('expired');
    expect(effectiveTipsStatus('paused', earlier, now)).toBe('expired');
    expect(effectiveTipsStatus('draft', earlier, now)).toBe('draft');
    expect(effectiveTipsStatus('archived', earlier, now)).toBe('archived');
    expect(effectiveTipsStatus('published', later, now)).toBe('published');
    expect(effectiveTipsStatus('published', null, now)).toBe('published');
  });

  it.each([
    ['pause', 'published', later, { kind: 'change', next: 'paused' }],
    ['pause', 'paused', later, { kind: 'unchanged' }],
    [
      'pause',
      'draft',
      null,
      { kind: 'rejected', code: 'TIPS_CAMPAIGN_INVALID_TRANSITION' },
    ],
    [
      'pause',
      'published',
      earlier,
      { kind: 'rejected', code: 'TIPS_CAMPAIGN_EXPIRED' },
    ],
    ['resume', 'paused', later, { kind: 'change', next: 'published' }],
    ['resume', 'paused', null, { kind: 'change', next: 'published' }],
    ['resume', 'published', null, { kind: 'unchanged' }],
    [
      'resume',
      'paused',
      earlier,
      { kind: 'rejected', code: 'TIPS_CAMPAIGN_EXPIRED' },
    ],
    [
      'resume',
      'archived',
      null,
      { kind: 'rejected', code: 'TIPS_CAMPAIGN_INVALID_TRANSITION' },
    ],
    ['archive', 'draft', null, { kind: 'change', next: 'archived' }],
    ['archive', 'paused', earlier, { kind: 'change', next: 'archived' }],
    ['archive', 'archived', null, { kind: 'unchanged' }],
  ] as const)('%s from %s', (action, status, expiresAt, expected) => {
    expect(nextTipsStatus(action, status, expiresAt, now)).toEqual(expected);
  });

  it('locks audience and expiry after publication and everything once archived', () => {
    const none = { touchesAudience: false, touchesExpiry: false };
    expect(
      tipsEditRejection('draft', {
        touchesAudience: true,
        touchesExpiry: true,
      }),
    ).toBeNull();
    expect(tipsEditRejection('published', none)).toBeNull();
    expect(
      tipsEditRejection('paused', { ...none, touchesAudience: true }),
    ).toBe('TIPS_CAMPAIGN_AUDIENCE_LOCKED');
    expect(
      tipsEditRejection('published', { ...none, touchesExpiry: true }),
    ).toBe('TIPS_CAMPAIGN_EXPIRY_LOCKED');
    expect(tipsEditRejection('archived', none)).toBe(
      'TIPS_CAMPAIGN_NOT_EDITABLE',
    );
  });
});

describe('chooseTipsBundle', () => {
  const rows: TipsTranslation[] = [
    { locale: 'en', title: 'T', description: 'D', action_label: 'Open' },
    { locale: 'ar', title: 'ع', description: 'و', action_label: 'افتح' },
    { locale: 'fr', title: 'T', description: 'D', action_label: null },
  ];

  it('uses the merchant locale when complete', () => {
    expect(chooseTipsBundle(rows, 'ar', true)?.locale).toBe('ar');
  });

  it('falls back to the whole English bundle', () => {
    expect(chooseTipsBundle(rows, 'fr', true)?.locale).toBe('en');
    expect(chooseTipsBundle(rows, 'ur', true)?.locale).toBe('en');
    expect(chooseTipsBundle(rows, 'fr', false)?.locale).toBe('fr');
  });

  it('returns null without usable English', () => {
    expect(chooseTipsBundle([rows[2]], 'ur', false)).toBeNull();
  });
});

describe('review token', () => {
  const hash = 'a'.repeat(64);

  it('round-trips revision and hash', () => {
    expect(parseTipsReviewToken(buildTipsReviewToken(7, hash))).toEqual({
      revision: 7,
      hash,
    });
  });

  it.each([undefined, '', '7', `x.${hash}`, `7.${'a'.repeat(63)}`])(
    'rejects %j',
    (token) => {
      expect(parseTipsReviewToken(token)).toBeNull();
    },
  );
});
