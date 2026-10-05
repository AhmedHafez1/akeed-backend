# E08 — WhatsApp Template Management

- **Horizon:** NEXT
- **Status:** Backlog (authored 2026-10-05; awaiting product-owner review)
- **Stories:** 8
- **Prerequisite epics:** [E02 — Platform Boundaries and Reliability](../02-platform-boundaries-and-reliability/README.md) (messaging port and per-send dispatch ledger). Regression gates from [E01](../01-shopify-baseline-stabilization/README.md), [E04](../04-standalone-manual-order-mvp/README.md), [E05](../05-standalone-order-ingestion-api/README.md), [E06](../06-easyorders-integration/README.md) and [E07](../07-woocommerce-integration/README.md) must stay green. E08 does not wait for any commerce epic to go live.
- **Roadmap:** [Expansion backlog](../README.md)

**Numbering note:** E08 was the EasyOrders epic's number until the 2026-10-03 renumbering. That epic is now [E06](../06-easyorders-integration/README.md), and no file in either repository still uses its old E08 or US-08 IDs. From 2026-10-05, E08 and US-08-0x mean this epic.

## Business objective

Make the WhatsApp templates Akeed sends a managed, observable asset instead of a hard-coded list. Staff can see exactly which Meta template went to each customer, how it performed, and whether Meta still allows it. Staff can create and retire templates without a deploy. A template Meta has paused or rejected is never sent.

## Current state (verified from code, 2026-10-05)

All paths are in `akeed-backend` unless they say otherwise.

**One message type.** There is one message type: a COD confirmation template with two quick-reply buttons. Their payloads are `confirm_<verificationId>` and `cancel_<verificationId>`. [`MessagingPort`](../../../src/shared/ports/messaging.port.ts) has a single `sendVerificationTemplate` method. [`WhatsAppService`](../../../src/infrastructure/spokes/meta/whatsapp.service.ts) builds the payload and posts it to `https://graph.facebook.com/v24.0/<phone-number-id>/messages`, which is the only Graph endpoint the code calls.

**The catalog.** [`cod-template-catalog.ts`](../../../src/shared/messaging/cod-template-catalog.ts) hard-codes 8 variants that map to 6 Meta template names:

| Language | Variant | Meta name | Language code | Parameters |
| --- | --- | --- | --- | --- |
| ar | `standard` (default) | `akeed_cod_verification_friendly` | `ar` | named: customer, store, order, total |
| ar | `egyptian` | `akeed_cod_verification_direct_eg` | `ar_EG` | named: customer, order, store, total |
| ar | `gulf` | `akeed_cod_verification_direct_gulf` | `ar` | named: customer, order, store, total |
| ar | `short` | `akeed_cod_verification` | `ar` | positional: order, total |
| en | `friendly` (default) | `akeed_cod_verification_friendly` | `en` | named: customer, store, order, total |
| en | `professional` | `_akeed_cod_verification_professional` | `en` | named: customer, store, order, total |
| en | `direct` | `akeed_cod_verification_direct_` | `en` | named: customer, order, store, total |
| en | `short` | `akeed_cod_verification` | `en` | positional: order, total |

**Where the template is reused, and what happens after a reply.**
- The same selected template is used for the first send, the single reminder (BullMQ job `verification.follow_up`, job id `…-follow-up-1`) and the onboarding test.
- The onboarding test gets no reminder or no-reply step. [`handleSyntheticTestOrder`](../../../src/modules/verification-core/verification-hub.service.ts) never calls `scheduleFollowUpAndEscalation`.
- Nothing is sent after the customer replies. [`WhatsAppWebhookService`](../../../src/infrastructure/spokes/meta/whatsapp.webhook.service.ts) has no messaging dependency.
- The no-reply job also sends no message.

**Store selection and language.**
- Each store picks one Arabic and one English variant: `integrations.cod_template_ar_variant` and `cod_template_en_variant`. Migration [`0021_add_cod_template_variants.sql`](../../../drizzle/0021_add_cod_template_variants.sql) enforces them with CHECK constraints.
- `integrations.default_language` is `auto`, `ar` or `en`.
- [`resolveTemplateLanguageForPhone`](../../../src/shared/messaging/template-language.ts) picks Arabic when the number starts with one of 22 Arabic-country calling codes. A local number without a country code resolves to English.

**What a send records.**
- Each dispatch writes `verification_message_dispatches.template_name` as `cod_verification` or `cod_verification:follow_up`, and `language_code` as the store preference, usually `auto`.
- The ledger `kind` is `initial`, `follow_up` or `legacy_unknown`. An onboarding test is an `initial` dispatch; only its order's `orders.is_test` tells it apart.
- The variant, Meta template name and resolved language are not stored anywhere. They appear only in the failure log.
- **Correction to the brief:** `verifications` also has `template_name` (default `cod_verification`) and `language_code` (default `ar`). Nothing writes them, so an English send reads `ar`. The admin store-detail query returns that value ([`admin-query.repository.ts`](../../../src/modules/admin/admin-query.repository.ts)).

**Preview text.**
- Each catalog entry carries a hand-kept preview: greeting, body, totalLabel, ending and the two button labels.
- **Correction to the brief:** the copy lives in the backend catalog only. The frontend has no copy. [`templatePreview.ts`](../../../../akeed-frontend/src/shared/lib/templatePreview.ts) only fills tokens.
- The same preview drives the Settings Message tab (both skins) and the onboarding test phone.
- Nothing compares it with Meta. In several variants, `totalLabel` holds order text rather than a total label.

**Meta template API.**
- The code never calls Meta's template management API.
- `WA_BUSINESS_ACCOUNT_ID` is in `.env.example` and is not read or validated by any code.
- **Correction to the brief:** [`docs/ENVIRONMENT.md`](../../ENVIRONMENT.md) and [`STANDALONE_BILLING_SANDBOX_PLAYBOOK.md`](../../STANDALONE_BILLING_SANDBOX_PLAYBOOK.md) still list it alongside the variables that are required.

**Inconsistencies (all confirmed).**
- A leading underscore in `_akeed_cod_verification_professional` and a trailing one in `akeed_cod_verification_direct_`.
- Arabic `standard` uses the `friendly` Meta name.
- Only `egyptian` uses a regional code (`ar_EG`).
- Both `short` variants are positional with two variables.
- Name fallbacks are English (`Customer`, `Akeed Store`) even in Arabic messages ([`whatsapp.service.ts`](../../../src/infrastructure/spokes/meta/whatsapp.service.ts)).
- The total is sent as `` `${totalPrice} ${currency}` `` (for example `123.40 USD`) from [`verification-send.service.ts`](../../../src/modules/verification-core/verification-send.service.ts). The onboarding test sends a fixed sample with the store's shipping currency, or `USD` if it has none.

**Typed replies.**
- [`customer-reply-intent.ts`](../../../src/shared/verification/customer-reply-intent.ts) matches exact short lists after normalization (NFKC, Arabic diacritics and tatweel removed, trailing punctuation removed, lower case).
- A typed reply also needs `context.id`, so it must be a reply to the template message.
- Anything else is logged as `unresolved_reply`, and the verification later runs out to `no_reply`.
- **Addition:** the entries `نعم.` and `لا.` can never match, because trailing punctuation is stripped before lookup. Alef and hamza forms are listed one by one, not folded.

**Webhook.** The WhatsApp webhook processes only `value.messages` and `value.statuses`. The DTO has no `field`. Template status, quality and category updates are neither subscribed nor handled.

**Tests.**
- No Meta template fake, no Meta contract config and no payload snapshot exist.
- `whatsapp.service.spec.ts` checks the payload for only 2 of the 8 variants (en `professional` and ar `short`).

**Admin.**
- Staff access is `AdminAccessGuard`: staff role, AAL2 in production, audited to `admin_access_audit`.
- Standalone billing writes add `StandaloneBillingOperatorGuard` with `STANDALONE_BILLING_OPERATIONS_ENABLED` and `STANDALONE_BILLING_OPERATOR_IDS`.
- "Admin health signals" are the per-store SQL rules in [`AdminHealthRuleService`](../../../src/modules/admin/admin-health-rule.service.ts), plus billing health alerts that are log lines (`standalone-billing-alert`). There is no push or email channel.
- The frontend Stores, Store detail and Funnel admin pages hard-code their text without next-intl. New E08 pages must not copy that.

**Stale merchant doc.**
- [`docs/MERCHANT_OPERATIONS.md`](../../MERCHANT_OPERATIONS.md) references 9 frontend paths that no longer exist, including the whole `features/message-preview` folder.
- It also describes tabs and redirects (`tab=message-preview`, `tab=confirmation`) that are now `message`, `timing` and `plan`.
- US-08-07g owns the fix, because it replaces that preview.

**Merchant help page.** [`content/docs/{en,ar}/whatsapp-templates.md`](../../../../akeed-frontend/content/docs/en/whatsapp-templates.md) tells merchants to A/B test styles weekly, but no send records its style. US-08-02 makes that advice measurable for staff. US-08-07g updates the page once the preview changes.

**Test sends.** Onboarding and Settings send the real template with sample data. The limits are `ONBOARDING_TEST_DAILY_LIMIT` = 5 per day and `ONBOARDING_TEST_COOLDOWN_SECONDS` = 30, set in [`product-events.ts`](../../../src/shared/analytics/product-events.ts).

**Rejection.** A 4xx from Meta with an error code is recorded as a confirmed rejection. Every other failure is kept as `outcome_unknown` for reconciliation.

**Known issue outside E08 scope.** A failed send logs the raw customer phone (`to` in the `WhatsAppService` failure log is not a redacted key). It is tracked separately and not fixed by this epic.

## Gaps this epic closes

The [current-state review (2026-10-05)](https://claude.ai/artifact/VNW6m8wkVrYiSb29F2k3z6) numbered twelve gaps. This table shows which story closes each one.

| Gap | Closed by |
| --- | --- |
| 1. Sends are not recorded per variant, so styles cannot be compared | US-08-02 |
| 2. Preview text is a hand-kept copy that nothing checks against Meta | US-08-04, US-08-05, US-08-07g |
| 3. The reminder resends the identical message | US-08-07a |
| 4. Nothing is sent after confirm or cancel | US-08-07b |
| 5. No items, address or delivery estimate | **Not in E08.** It needs new order data, not template work. |
| 6. One Arabic dialect per store | US-08-07d |
| 7. Inconsistent naming | US-08-03 (legacy names kept and mapped), US-08-06 (convention for new names) |
| 8. The four-block preview model does not fit the variants | US-08-07g |
| 9. Legacy positional `short` variant | US-08-03 (modelled as is), US-08-06 (retire path) |
| 10. English name fallbacks and the Akeed name | US-08-07e |
| 11. Raw amount format | US-08-07f |
| 12. Typed replies only match exactly | US-08-07c |

**Approved direction (product owner, 2026-10-05):** Meta is the source of truth for template text. Akeed stores a synced snapshot and renders every preview from it. Merchants keep choosing a style and never write text.

## Environment model

Dev and prod are separate Meta apps. Each has its own WhatsApp Business Account, phone number ID, access token and app secret, and each holds its own templates. A deployment's `.env` always carries the IDs of its own app, so the code is environment-agnostic.

Consequences that every story follows:
- Meta template IDs, review status, category and quality are environment data. They come from each environment's own sync, never from a migration or a fixture.
- Stable template keys, purposes, languages and variable mappings are shared across environments.
- A template created in dev does not exist in prod. Bringing it to prod is a separate submit and Meta review there.
- Reconciliation and the live run are done per environment, dev first.

## Scope and boundaries

In scope:
- A Meta contract record and live reconciliation.
- Template identity recorded per send.
- A database template registry that replaces the code catalog.
- Meta sync, status, quality and category webhooks, and a send guardrail with fallback.
- Admin pages to inspect, create, edit, submit, activate, set default and retire templates, with operator gating.
- Seven switchable message improvements.
- A release gate.

Rules for the whole epic:
- **Staff only.** Template writes live under `/api/admin` behind `AdminAccessGuard` plus an operator allowlist modeled on the billing operator gating. Merchants never create or edit template text; they only choose among active templates.
- **Meta details stay in the Meta spoke.** Endpoint shapes, component JSON, status names and error codes live behind a port. Verification core, the hub and shared frontend code see neutral types only.
- **One sender.** Every template belongs to the single Akeed sender.
- **Only approved and active templates are sent.** A template must be approved at Meta and active in Akeed. Anything else falls back to the language default. If the default is unavailable, the send is skipped with a recorded reason and never guessed.
- **No customer-facing change before US-08-07.** US-08-02 to US-08-06 change no customer-facing message. A characterization test proves the Meta payload for every existing variant and language is byte-identical before and after.
- **Secrets and safe logging.** Access tokens and app secrets are never logged, returned or put in fixtures. Template text and customer data in logs go through `buildBackendLog`.
- **Hand-written migrations.** Each migration is the next numbered `drizzle/NNNN_name.sql` plus a `_journal.json` entry. The next number on 2026-10-05 is `0053`. Migrations are additive first, each with a written rollback.
- **No regressions.** Shopify, Standalone (manual, import, API), EasyOrders and WooCommerce sends keep working, and their tests pass untouched.

**Out of scope:**
- Tenant or merchant-owned senders and templates.
- Merchant-authored template text.
- Order items, shipping address or delivery estimate in the message (gap 5).
- Message types other than COD confirmation and the purposes listed here, such as marketing campaigns, order-status updates and OTP.
- Media, location or document headers.
- Automatic translation.
- Meta template IDs or statuses in migrations.
- Changing the reply-matching word lists, other than what US-08-07c needs.
- Changing reminder count or timing.
- A push, email or pager alert channel unless US-08-04's decision adds one.
- The plain-text phone log issue above.

## Validation rule

From US-08-02 on, the US-08-01 contract record (`evidence/US-08-01-contract-record.md`, written by US-08-01) is the only source of truth for Meta behavior.
- Each finding is labelled VERIFIED (observed on the Akeed dev or prod app, dated), DOCUMENTED (Meta's documentation, with URL and read date) or UNKNOWN.
- Each UNKNOWN has a worst-case rule the code follows.
- If a story needs something the record does not answer, work stops and the product owner is asked. Nothing is filled in from memory or public docs.
- A later contradiction updates the record and reopens only the affected story.

## Prioritized user stories

Delivery rank is the execution order. All stories start in Backlog.

| Rank | Story | Priority | Type | Direct dependencies | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | [US-08-01 — Meta contract and live template reconciliation](US-08-01-meta-contract-and-live-template-reconciliation.md) | P0 | Contract and plan | [US-02-07](../02-platform-boundaries-and-reliability/US-02-07-platform-boundary-release-gate.md) | Backlog |
| 2 | [US-08-02 — Record template identity per send](US-08-02-record-template-identity-per-send.md) | P0 | Technical enabler | [US-08-01](US-08-01-meta-contract-and-live-template-reconciliation.md) | Backlog |
| 3 | [US-08-03 — Template registry and send-path cutover](US-08-03-template-registry-and-send-path-cutover.md) | P0 | Technical enabler | [US-08-02](US-08-02-record-template-identity-per-send.md) | Backlog |
| 4 | [US-08-04 — Meta sync, status webhooks and send guardrail](US-08-04-meta-sync-status-webhooks-and-send-guardrail.md) | P0 | Feature | [US-08-03](US-08-03-template-registry-and-send-path-cutover.md) | Backlog |
| 5 | [US-08-05 — Admin: inspect templates](US-08-05-admin-inspect-templates.md) | P0 | Feature | [US-08-04](US-08-04-meta-sync-status-webhooks-and-send-guardrail.md) | Backlog |
| 6 | [US-08-06 — Admin: create, edit, submit, activate, retire](US-08-06-admin-create-edit-submit-activate-retire.md) | P0 | Feature | [US-08-05](US-08-05-admin-inspect-templates.md) | Backlog |
| 7 | [US-08-07 — Message improvements](US-08-07-message-improvements.md) | P1 | Feature | [US-08-06](US-08-06-admin-create-edit-submit-activate-retire.md) | Backlog |
| 8 | [US-08-08 — Release gate](US-08-08-release-gate.md) | P0 | Quality gate | [US-08-07](US-08-07-message-improvements.md) | Backlog |

## Measurable exit criteria

- The US-08-01 record has no UNKNOWN that blocks any of these without a worst-case rule: sending, status handling, editing or the free-form window.
- The record has been run against both the dev and prod apps.
- **Characterization (US-08-03, kept through US-08-08):** for all 8 variants on every path (first send, reminder, onboarding test), the Meta payload is byte-identical to the pre-epic baseline while every US-08-07 switch is off.
- **Guardrail:** no send uses a template that is not both approved at Meta and active in Akeed. Each fallback and each skip records its reason.
- **Staff controls:** non-staff get 403/404 on every template route, and non-operators get 403 on every template write. Every write is audited.
- **Regressions:** the E01, E04, E05, E06 and E07 automated regression gates pass untouched.
- **Live run:** the US-08-08 live run is done on dev, then on prod, and the product owner records go or no-go.
- Every story meets its acceptance criteria and the [shared Definition of Done](../README.md#shared-definition-of-done).

## Dependency and rollout notes

- The order is strictly linear. US-08-02 must ship before US-08-03 so the cutover can be compared on real sends, and US-08-03 must ship before any feature reads the registry.
- New behavior ships behind switches, all off by default. Each switch is named in its story.
- Rolling back any story never needs a code revert to restore sending: the code-seeded defaults from US-08-03 remain a valid registry state.
- No calendar estimate or staffing commitment is implied by priority.

## Open decisions (product owner)

Each story lists its own open decisions after its acceptance criteria. The ones that change the design:

1. **US-08-01:** run the reconciliation script on prod in this story, or on dev first and prod at the gate; and who runs it with the prod token.
2. **US-08-02:** fill the dead `verifications.template_name` and `language_code` columns with real values, or deprecate them.
3. **US-08-03:** the stable key scheme. Also confirm that keys are global while the Meta snapshot is per environment.
4. **US-08-04:** the alert channel, and what happens when a language default itself becomes unavailable.
5. **US-08-06:** the naming convention, one-person or two-person submit, and the dev→prod promotion flow.
6. **US-08-07:**
   - Approval of every copy draft.
   - Whether free-form messages (acknowledgment and nudge) live in the registry.
   - Switch scope: global or per store.

## Evidence discipline

This backlog was written from a code reading on 2026-10-05 (`develop` at `639c7bf`). No application test, migration, Meta API call or WhatsApp send was run to write it. Meta behavior is not described here beyond what the code does. The contract record is the only place it will be stated.
