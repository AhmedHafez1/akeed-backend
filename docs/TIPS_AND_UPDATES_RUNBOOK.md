# Tips and Updates Runbook

Admins publish tips and feature announcements to chosen merchant accounts. Merchants see them in Tips & updates, and admins can also show a campaign as a slim banner on the dashboard and confirmations in both Shopify and standalone. Campaigns never send email, WhatsApp, push or popups. Every campaign is created and published by hand. Publication saves the initial audience; staff can explicitly add, remove or reissue individual merchant accounts afterward. Nothing is triggered automatically.

## Where it lives

| Part | Place |
| --- | --- |
| Admin screens | `/en/admin/tips` (list), `/en/admin/tips/new`, `/en/admin/tips/:id` in the control tower |
| Admin API | `api/admin/tips-campaigns`, including `POST :id/banner` with `{ show_as_banner: boolean }` (`AdminTipsCampaignsController`, `AdminAccessGuard`) |
| Merchant API | `GET api/tips`, `POST api/tips/:id/view`, `POST api/tips/:id/click`, `POST api/tips/:id/dismiss` (`TipsController`, `DualAuthGuard`) |
| Rules | `src/shared/tips-campaigns/tips-campaign.policy.ts`, button pages in `tip-action-routes.ts`, error codes in `tips-campaign.errors.ts` |
| Data | `tips_campaigns`, `tips_campaign_translations`, `tips_campaign_recipients` (`drizzle/0077_tips_campaigns.sql`), via `TipsCampaignsRepository` |
| Merchant cards and banners | `akeed-frontend/src/features/tips` (standalone and Polaris skins, shared event tracking) |

Any admin who passes the control tower guard can create and publish campaigns. Every create, edit, publish, pause, resume, archive, banner change and changed recipient batch writes an `admin_access_audit` row (`tips-campaign.<action>`) in the same transaction as the change. Banner changes use `tips-campaign.banner` with `{ campaignId, showAsBanner }` metadata. Recipient changes use `tips-campaign.recipients.add|remove|reissue` with affected organization ids and the new revision.

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
- The Banner switch is available in each list row and on a saved campaign's page. It is off for existing and new campaigns by default. It saves immediately for draft, published and paused campaigns (including expired ones), but is disabled for archived campaigns. It changes only display: revision and review stay valid, and unsaved content stays in the editor. Repeating the current setting makes no change and writes no audit row. A flag never overrides publication, targeting, expiry or dismissal rules.
- Published and paused campaigns support explicit account additions, removals and **Show again**. Expired and archived campaigns are read-only for recipient changes. The publication rules and expiry remain fixed; filters are never rerun automatically.

## Content

- Every campaign has a type, shown to merchants as a badge: `tip` (Tip, advice), `update` (New feature), `change` (Update: Akeed changed how something works) or `note` (Note: information only).
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
| WhatsApp message language | `integrations.default_language` | `ar`, `en`, `ur`, `es`, `fr`, `tr`, `auto` or `storefront`. This is not the dashboard language. |
| Current plan | `integrations.billing_plan_id` with `billing_status` | Starter, Basic, Pro or Scale count only for Shopify stores whose billing status is `active` or `not_required`. "Prepaid credits" means a standalone, EasyOrders or WooCommerce source. |
| Features | `auto_cancel_enabled`, `quiet_hours_enabled`, `follow_up_enabled`, `escalation_enabled`, `is_auto_verify_enabled`, `logo_header_enabled` | Each can be required on or off. A missing value matches neither. The logo header filter reads the staff switch, not whether the banner actually shows. |

## Review and publish

1. **Review** (`POST .../:id/review`). The server validates the content, requires a future expiry and counts the audience. It records the count and a SHA-256 hash of the sorted organization ids against the campaign's current `revision`. It refuses an empty audience (`TIPS_CAMPAIGN_NO_RECIPIENTS`) and more than 50,000 recipients (`TIPS_CAMPAIGN_AUDIENCE_TOO_LARGE`). The admin then sees the card preview in every language, the criteria, the exclusions, the expiry and the searchable recipient list. The preview records no analytics.
2. **Publish** (`POST .../:id/publish` with the review token). One transaction locks the campaign, inserts the recipients from the live audience and hashes them in the same statement, then marks the campaign published.
   - If a content or audience edit changed the revision after review, publication is refused with `TIPS_CAMPAIGN_REVIEW_REQUIRED`. A banner switch leaves that review valid.
   - If the audience changed, everything rolls back and the publish is refused with `TIPS_CAMPAIGN_AUDIENCE_CHANGED`, which carries the new count. Merchants never see a partial or unreviewed list.
   - Repeating the publish with the same token returns the published campaign (`already_published: true`).

## Manage enrolled accounts

After publication, the recipient section has **Enrolled accounts** and **Find accounts to add**, with search, pagination and selections of up to 500 accounts per action. An account is an organization, not an individual teammate.

- **Add accounts** enrolls accounts with an active store as unread. Adding an already enrolled, undismissed account is a no-op. Removed or dismissed accounts require **Show again**.
- **Remove** soft-removes enrolled accounts, including accounts whose store is now inactive. Their rows and activity remain available, but merchant reads and events exclude them.
- **Show again** restores a removed or dismissed account with an active store. It archives the previous delivery in `tips_campaign_delivery_history`, increments `delivery_generation`, clears current engagement timestamps and starts a new unread delivery. Reissuing an active, undismissed delivery changes nothing.
- Staff confirm the selected count and visibility effect. Paused campaigns accept edits but remain hidden until resumed. No operation changes publication criteria, expiry or publication time.
- Current analytics count active enrollments, including dismissed accounts, and their current-delivery activity. Removed accounts do not count. Expand **Previous deliveries** on an account to inspect earlier engagement and removal timestamps.

`POST api/admin/tips-campaigns/:id/recipients` accepts `{ revision, operation: "add" | "remove" | "reissue", org_ids }`. It validates the whole batch, locks the campaign and affected recipients, checks active-store eligibility for adds/reissues, enforces the 50,000 active-enrollment limit, and writes the operation and audit atomically. A changed batch increments the campaign revision; stale retries conflict without reapplying. A no-op leaves the revision and audit unchanged.

The picker is `GET .../:id/recipient-options`; previous deliveries are paginated through `GET .../:id/recipients/:orgId/history?before=<generation>&limit=25`. Existing draft audience controls continue to work; recipient rows are first created at publication.

Merchant cards include `delivery_generation`. View, click and dismiss bodies carry that generation. Requests without it belong only to generation 1; old-generation events are ignored with `{ recorded: false }`. All event SQL checks the authenticated organization, current generation and removal state. Merchant observers and cached read/dismiss state are keyed by generation.

Delivery history is service-role-only, with RLS and no access for anonymous or authenticated database roles. Migration `0087_tips_recipient_deliveries.sql` backfills existing recipients to generation 1 without changing engagement timestamps. Its journal timestamp is immediately after 0084 and before the reserved WhatsApp migrations 0085/0086, so it can ship independently. Drizzle applies migrations by journal timestamp, not filename number. When integrating the WhatsApp branch, preserve this applied timestamp, keep journal entries in timestamp order and renumber only unapplied journal indexes as needed.

Additional error codes: `TIPS_RECIPIENT_INELIGIBLE`, `TIPS_RECIPIENT_REISSUE_REQUIRED`, `TIPS_RECIPIENT_NOT_ENROLLED`.

## Merchant side

- A card shows when the organization is a recipient, the campaign is published (not paused or archived), it has not expired and the organization has not dismissed it.
- Cards appear newest account delivery first, at most 20. An added or reissued delivery starts at the time of that action; the original publication date stays unchanged. Shopify shows them in the header’s Tips & updates popover; standalone shows a dashboard section. When there are no cards, or loading fails, the entry point stays hidden.
- With `show_as_banner` on, a visible card also appears as a single-line banner above the dashboard and confirmations. It stays in the menu or section. Only the newest flagged card from the same eligible card list appears; dismissing it advances to the next. Turning the flag off leaves the card in the menu or section. Missing flags from an older API are treated as off.
- The banner contains the type badge, a truncated title, the optional campaign action and a dismiss icon. The description remains in the menu or section. Title and action use the campaign content's language and direction. Standalone targets a compact 44-pixel height; embedded uses a subdued Polaris surface.
- **View:** Shopify records a view after at least half the card is visible for two continuous seconds in an active browser tab, or when its action is clicked. Standalone records a view when at least half the card is on screen. The server keeps the first timestamp for the organization. The merchant API returns `first_viewed_at`; null means unread. Shopify uses a blue bulb and per-card dots for unread cards. Reading clears the indicators for the whole store on subsequent fetches; it does not remove the cards.
- **Click:** recorded without delaying navigation, only for a campaign with a button.
- **Dismiss:** hides the current delivery for the organization, on every device and for every member, until staff explicitly use **Show again**. Owners and admins can dismiss; viewers see cards without a dismiss control, and the server refuses their dismissal (`TIPS_DISMISS_FORBIDDEN`). If saving fails, the card comes back with an error message.
- Banners use the same view, click and dismiss handlers as cards. Their views follow the same visibility rules for each mode, and the server retains one first timestamp per organization. Dismissing either surface hides both; a failed dismissal restores both. Viewers retain the action but see no dismiss icon.
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
WHERE campaign_id = '<campaign id>' AND removed_at IS NULL;

-- What one organization would see now.
SELECT c.id, c.name, c.published_at
FROM tips_campaign_recipients r
JOIN tips_campaigns c ON c.id = r.campaign_id
WHERE r.org_id = '<org id>'
  AND r.dismissed_at IS NULL
  AND r.removed_at IS NULL
  AND c.status = 'published'
  AND (c.expires_at IS NULL OR c.expires_at > now())
ORDER BY r.delivery_started_at DESC, c.id DESC;

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
