# US-08-05 — Admin: inspect templates

- **Epic:** [E08 — WhatsApp Template Management](README.md)
- **Delivery rank:** 5 of 8
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Feature
- **Status:** Implemented (2026-10-05); the staff test send is off until `WHATSAPP_TEMPLATE_TEST_PHONES` is set. Not marked Done: the pages have not been opened against a real environment, and US-08-04 still waits for the webhook subscription to be confirmed — [evidence](../../US-08-05-ADMIN-INSPECT-TEMPLATES-EVIDENCE.md)
- **Dependencies:** [US-08-04](US-08-04-meta-sync-status-webhooks-and-send-guardrail.md)

## User story and value

As Akeed staff, I want one place to see every template, its Meta status, the text Meta actually holds, who uses it and how it performs, so that I can spot a broken or weak template before merchants do.

**Business value:** makes the registry, the sync and the US-08-02 metrics visible. It also shows staff when the preview has drifted from Meta (gap 2) and lets them test a template on their own phone.

## Scope

- An admin list page and a detail page.
- A drift warning.
- A test send to a staff phone.
- On-demand sync.

The pages are read-only apart from sync and test send.

**Out of scope:**
- Creating, editing, submitting, activating or retiring templates (US-08-06).
- Merchant-facing changes.
- Exporting metrics.

## Acceptance criteria

1. **List page.** `/[locale]/admin/templates` lists every registry template. For each one it shows:
   - key, purpose and language;
   - Meta name and language code;
   - review status, category and quality;
   - active and default flags;
   - last sync time;
   - the number of active stores using it;
   - sends and confirmation rate over the selected date range, from US-08-02.

   The list can be filtered by purpose, language, status and active flag. It has loading, empty and error states.
2. **Detail page.** `/[locale]/admin/templates/[key]` shows:
   - **Text:** the registered text rendered from the Meta components snapshot in the existing phone preview ([`src/shared/ui/whatsapp/`](../../../../akeed-frontend/src/shared/ui/whatsapp)), with sample values.
   - **Variable mapping:** neutral variable, then Meta parameter name or position, then sample value.
   - **Status:** status history from webhooks and syncs.
   - **Stores:** the stores that select it (masked or named per open decision 2).
   - **Metrics:** per-purpose metrics (sends, replies, confirmations, cancellations, no-replies) with a date range.
3. **Drift warning.** A drift warning appears when the Meta snapshot differs from what Akeed sends or previews. That covers a body, button, parameter-format or language-code difference, and a template missing at Meta. The comparison runs in the backend, and the page shows what differs.
4. **Sync now.** The "Sync now" action calls the US-08-04 sync and shows the result: updated, unchanged, unknown at Meta and missing at Meta.
5. **Test send.** A staff member sends the template, with sample values, to a staff phone on the allowlist in open decision 1.
   - The send is billing-exempt and creates no merchant order or verification.
   - Its button payloads cannot change any verification: they use an id that the webhook resolves to nothing, and that path is ignored as today.
   - It respects the guardrail: a non-sendable template cannot be test-sent.
   - It is rate limited, and it is audited in `admin_access_audit` with no phone number or text in the metadata.
6. **Access control.**
   - Every route is behind `AdminAccessGuard`. Non-staff get the existing 404/403 behavior.
   - Sync and test send also need the operator allowlist from US-08-06 (or its guard, if this story ships first).
   - Responses never include tokens, the app secret or the provider's raw error body.
7. **Frontend conventions.**
   - The pages use `AdminShell`, the `AdminUi` components and next-intl.
   - A new `adminTemplates` namespace is added to both [`ar.json`](../../../../akeed-frontend/public/messages/ar.json) and [`en.json`](../../../../akeed-frontend/public/messages/en.json).
   - Pages are RTL in Arabic and keyboard accessible.
   - A "Templates" entry is added to the admin navigation.

## Open decisions (product owner)

1. **Test phone allowlist.** Either an environment variable such as `WHATSAPP_TEMPLATE_TEST_PHONES` (proposal; separate per environment), or a per-staff phone stored in the database.
2. **Stores using a template.** Should the list show store names and domains, or only counts and masked identifiers? The existing admin store pages show store names to staff.
3. **Default date range.** The proposal is the last 30 days.

**Decided 2026-10-05 (product owner):**
1. The environment variable `WHATSAPP_TEMPLATE_TEST_PHONES`, per environment. Empty keeps test sends off.
2. Store names, platform and a link to the admin store page.
3. The last 30 days.
4. The test send follows criterion 5 as written: no order, verification or dispatch. It is recorded as one audit row with purpose `test`, and is not counted in template metrics.

## Implementation notes

- **Backend:**
  - Read endpoints under `/api/admin/templates` (list, detail, metrics, status history, drift) in the admin module.
  - `POST /api/admin/templates/:key/test-send`, built on the messaging port with a neutral "staff test" purpose.
  - Drift comparison is a pure function over neutral types plus a spoke-provided renderer of the snapshot.
- **Frontend:**
  - `src/features/admin/` gains a templates page, a template detail page, an API module and hooks, following [`StandaloneBillingPage.tsx`](../../../../akeed-frontend/src/features/admin/StandaloneBillingPage.tsx) and [`adminApi.ts`](../../../../akeed-frontend/src/features/admin/adminApi.ts).
  - Routes go under `src/app/[locale]/admin/templates/`.
  - Render the snapshot through a neutral "rendered message" type (text lines plus button labels) so shared UI never sees Meta JSON.
- **Data:** None beyond US-08-04. The test send is recorded only as an audit row.
- **Operations:**
  - Document the test-phone variable in [`docs/ENVIRONMENT.md`](../../ENVIRONMENT.md).
  - Write a short staff note in [`docs/INTEGRATIONS_WEBHOOKS_AND_AUTOMATION.md`](../../INTEGRATIONS_WEBHOOKS_AND_AUTOMATION.md) on reading drift and status.

## Test requirements

- Backend:
  - access control on every route (staff, non-staff, operator, non-operator);
  - list and detail DTOs contain no secrets;
  - drift cases (equal, body differs, button differs, format differs, missing at Meta);
  - test send to an allowlisted phone, a non-allowlisted phone, a non-sendable template, rate limiting and the audit row;
  - a reply to a test message changes nothing.
- Frontend (Vitest):
  - list and detail render in `ar` and `en`, plus empty, loading and error states;
  - drift banner;
  - the phone preview renders the snapshot;
  - no missing translation keys.
- Frontend `npm run build`, `npm run lint`, `npx tsc --noEmit` and `npm run test` pass. Backend lint (non-fixing), build and test pass.
- The characterization suite and the E01, E04, E05, E06 and E07 regressions pass untouched.

## Migration and rollout

- No migration.
- The pages appear only to staff while `ADMIN_CONTROL_TOWER_ENABLED` is on.
- The test send stays off until the allowlist is configured.
- **Rollback:** hide the navigation entry and revert. Nothing customer-facing depends on it.

## Evidence and references

**VERIFIED FROM CODE (2026-10-05):**
- The admin routes are `api/admin/*` behind [`admin-access.guard.ts`](../../../src/modules/admin/admin-access.guard.ts).
- The frontend admin uses [`AdminShell.tsx`](../../../../akeed-frontend/src/features/admin/AdminShell.tsx) and [`AdminUi.tsx`](../../../../akeed-frontend/src/features/admin/AdminUi.tsx), with admin translation namespaces `adminCommon`, `adminBilling`, `adminBillingOps` and `adminBillingObservability`.
- The Stores, Store detail and Funnel admin pages hard-code their text. New pages must not copy that.
- The phone preview components exist in [`src/shared/ui/whatsapp/`](../../../../akeed-frontend/src/shared/ui/whatsapp).

**ASSUMPTION / REQUIRES VALIDATION:** that a staff test send is allowed by the US-08-01 record under the same rules as a merchant send. The record decides whether a test to a number outside the customer service window needs an approved template. Under this story's guardrail, it always uses one.

**EXTERNAL PLATFORM DEPENDENCY:** Meta send API (as today) and the US-08-04 sync.
