# Tips and Updates Runbook

Admins publish tips and feature announcements to chosen merchant accounts. Merchants see them as dismissible cards on the dashboard overview, never as email, WhatsApp, push or popups. Every campaign is created and published by hand. Nothing is triggered automatically, and nothing is added to a campaign after it is published.

## Where it lives

| Part | Place |
| --- | --- |
| Admin screens | `/en/admin/tips` (list), `/en/admin/tips/new`, `/en/admin/tips/:id` in the control tower |
| Admin API | `api/admin/tips-campaigns` (`AdminTipsCampaignsController`, `AdminAccessGuard`) |
| Merchant API | `GET api/tips`, `POST api/tips/:id/view`, `POST api/tips/:id/click`, `POST api/tips/:id/dismiss` (`TipsController`, `DualAuthGuard`) |
| Rules | `src/shared/tips-campaigns/tips-campaign.policy.ts`, button pages in `tip-action-routes.ts`, error codes in `tips-campaign.errors.ts` |
| Data | `tips_campaigns`, `tips_campaign_translations`, `tips_campaign_recipients` (`drizzle/0077_tips_campaigns.sql`), via `TipsCampaignsRepository` |
| Merchant cards | `akeed-frontend/src/features/tips` (standalone card, Polaris card, view tracking) |

Any admin who passes the control tower guard can create and publish campaigns. Every create, edit, publish, pause, resume and archive writes an `admin_access_audit` row (`tips-campaign.<action>`) in the same transaction as the change.

## Lifecycle

| State | Merchants see it | Allowed next |
| --- | --- | --- |
| Draft | No | Publish, archive |
| Published | Yes, until the expiry | Pause, archive |
| Paused | No | Resume (only before the expiry), archive |
| Expired (published or paused, past `expires_at`) | No | Archive |
| Archived | No | None. Read-only |

- "Expired" is never stored. Every read compares `expires_at` with the database clock, so no cleanup job is needed.
- Repeating an action that already holds succeeds without change, so retries are safe.
- In a draft, every field can change. After publication only the name, type, translations and button change. The audience and expiry stay as published. A content edit keeps `published_at`, the recipients, the analytics and every dismissal.
- To reach other merchants, or to show a card again, create a new campaign. There is no resend and no reset of dismissals.

## Content

- English is required and must be complete. Every other interface language is either complete or absent. A merchant reads their dashboard language when it is complete, otherwise the whole English bundle. A title is never mixed with a body or button in another language.
- Text is plain, with line breaks kept. The title is 1–80 characters with at most 1 line break, the description 1–500 with at most 8, the button label 1–30, and the internal name 1–120.
- The button is optional. It is either an Akeed page key, mapped by the frontend to the page in the merchant's mode with the Shopify context kept, or an absolute `https://` link to a public host, opened in a new tab. `javascript:`, `data:`, protocol-relative and credential links are refused. A page that does not exist in a mode (for example `imports_new` in Shopify) shows no button there.
- There is no campaign image.

## Audience

Recipients are organizations with an active store (`integrations.is_active = true`; an organization has at most one). Each organization is one recipient, and a dismissal hides the card for everyone in it.

- **Pick merchants:** up to 500 organizations chosen by name search.
- **Filters:** different filters must all match, and any value inside one filter matches. A filter left empty matches everyone. Up to 500 matching organizations can be excluded one by one.

| Filter | Source | Notes |
| --- | --- | --- |
| Store country | `integrations.country_code` | Known only for Shopify stores, from the Shopify billing address. A store with no country never matches. Country is not a language preference. |
| Platform | `integrations.platform_type` | `shopify`, `standalone`, `easyorders`, `woocommerce`. |
| Signup date | `organizations.created_at` | Whole UTC days, both ends included. A missing date never matches. |
| WhatsApp message language | `integrations.default_language` | `ar`, `en`, `ur`, `es`, `fr`, `tr` or `auto`. This is not the dashboard language. |
| Current plan | `integrations.billing_plan_id` with `billing_status` | Starter, Basic, Pro or Scale count only for Shopify stores whose billing status is `active` or `not_required`. "Prepaid credits" means a standalone, EasyOrders or WooCommerce source. |
| Features | `auto_cancel_enabled`, `quiet_hours_enabled`, `follow_up_enabled`, `escalation_enabled`, `is_auto_verify_enabled`, `logo_header_enabled` | Each can be required on or off. A missing value matches neither. The logo header filter reads the staff switch, not whether the banner actually shows. |

## Review and publish

1. **Review** (`POST .../:id/review`). The server validates the content, requires a future expiry and counts the audience. It records the count and a SHA-256 hash of the sorted organization ids against the campaign's current `revision`. It refuses an empty audience (`TIPS_CAMPAIGN_NO_RECIPIENTS`) and more than 50,000 recipients (`TIPS_CAMPAIGN_AUDIENCE_TOO_LARGE`). The admin then sees the card preview in every language, the criteria, the exclusions, the expiry and the searchable recipient list. The preview records no analytics.
2. **Publish** (`POST .../:id/publish` with the review token). One transaction locks the campaign, inserts the recipients from the live audience and hashes them in the same statement, then marks the campaign published.
   - If any edit happened after the review, the publish is refused with `TIPS_CAMPAIGN_REVIEW_REQUIRED`.
   - If the audience changed, everything rolls back and the publish is refused with `TIPS_CAMPAIGN_AUDIENCE_CHANGED`, which carries the new count. Merchants never see a partial or unreviewed list.
   - Repeating the publish with the same token returns the published campaign (`already_published: true`).

## Merchant side

- A card shows when the organization is a recipient, the campaign is published (not paused or archived), it has not expired and the organization has not dismissed it.
- Cards appear newest publication first, at most 20, below the operational alerts and above the KPIs, including during the first run. If there are none, or the read fails, no section renders.
- **View:** recorded once, when at least half of the card is on screen (IntersectionObserver). The server keeps the first timestamp, so refreshes and other staff never add to it.
- **Click:** recorded without delaying navigation, only for a campaign with a button.
- **Dismiss:** permanent for the organization, on every device and for every member. Owners and admins can dismiss; viewers see cards without a dismiss control, and the server refuses their dismissal (`TIPS_DISMISS_FORBIDDEN`). If saving fails, the card comes back with an error message.
- An event for a campaign the organization did not receive answers `TIPS_CARD_NOT_FOUND`, the same as a campaign that does not exist.

## Error codes

`TIPS_CAMPAIGN_NOT_FOUND`, `TIPS_CAMPAIGN_INVALID` (422 with `issues: [{ field, code, locale? }]`), `TIPS_CAMPAIGN_REVISION_CONFLICT`, `TIPS_CAMPAIGN_NOT_EDITABLE`, `TIPS_CAMPAIGN_AUDIENCE_LOCKED`, `TIPS_CAMPAIGN_EXPIRY_LOCKED`, `TIPS_CAMPAIGN_INVALID_TRANSITION`, `TIPS_CAMPAIGN_EXPIRED`, `TIPS_CAMPAIGN_NO_RECIPIENTS`, `TIPS_CAMPAIGN_AUDIENCE_TOO_LARGE`, `TIPS_CAMPAIGN_REVIEW_REQUIRED`, `TIPS_CAMPAIGN_AUDIENCE_CHANGED`, `TIPS_CARD_NOT_FOUND`, `TIPS_DISMISS_FORBIDDEN`.

## Read-only inspection

```sql
-- Reach of one campaign.
SELECT count(*) AS recipients,
       count(first_viewed_at) AS viewed,
       count(first_clicked_at) AS clicked,
       count(dismissed_at) AS dismissed
FROM tips_campaign_recipients
WHERE campaign_id = '<campaign id>';

-- What one organization would see now.
SELECT c.id, c.name, c.published_at
FROM tips_campaign_recipients r
JOIN tips_campaigns c ON c.id = r.campaign_id
WHERE r.org_id = '<org id>'
  AND r.dismissed_at IS NULL
  AND c.status = 'published'
  AND (c.expires_at IS NULL OR c.expires_at > now())
ORDER BY c.published_at DESC, c.id DESC;

-- Who changed a campaign.
SELECT created_at, user_id, action, metadata
FROM admin_access_audit
WHERE action LIKE 'tips-campaign.%' AND metadata->>'campaignId' = '<campaign id>'
ORDER BY created_at;
```

## Tests

- Unit: `npx jest src/shared/tips-campaigns src/modules/tips src/modules/admin/admin-tips-campaigns.service.spec.ts`.
- Postgres contract (Docker): `scripts/test-tips-campaigns-contract.ps1` (`npm run test:contract:tips-campaigns` with `E01_TEST_DATABASE_URL`).
- Frontend: `npx vitest run src/features/tips src/features/admin/admin-tips.model.test.ts src/features/admin/TipCampaignEditorPage.test.tsx`.
