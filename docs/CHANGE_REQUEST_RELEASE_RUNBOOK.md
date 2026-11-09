# Customer change requests: release and recovery

Change requests are merchant opt-in and default off. Shipping protection is an attention warning and, on Shopify, an Akeed-owned tag; it is not a fulfillment hold. This runbook does not authorize deployment, template submission, production changes or real notifications.

## Draft preparation and review

Use the target environment's registry and synchronized provider content as the source of truth. A dev inventory does not establish production coverage. In Admin > Templates, Request a change preparation reviews each exact predecessor, preserves existing drafts and uncertain submissions, prepares missing text drafts, and exports content, sample values and image-twin plans. Missing, draft, submitting, uncertain, pending, rejected, approved, inactive and drifted states are distinct; preparation and provider acceptance do not establish readiness.

For authorized draft-only database maintenance before deploying application changes, `node scripts/prepare-change-request-production.cjs <snapshot.json> <output-directory>` is an offline authoring command. It reads no environment files, connects to no database and calls no provider. It requires a verified journal through migration 0092, then produces `prepare-through-0093.sql`, `review.json` and `review.md`. Validate the exact batch with `pwsh -NoProfile -File scripts/test-change-request-preparation-contract.ps1` against disposable PostgreSQL. Execute the reviewed SQL as one transaction through the authorized maintenance channel. It holds the existing migration advisory lock, verifies the source fingerprint and journal, applies original migration 0093 only, corrects only newly seeded unchanged drafts, verifies preservation of existing templates, and records the original LF migration hash in Drizzle history. A changed fingerprint or journal aborts the batch; refresh and review rather than bypassing the guard. Never run the unrestricted application migrator for this bounded step.

After maintenance, verify exact content and counts, unchanged old templates/defaults/statuses, and no later migration entry. Preserve the export with release evidence. Migration 0094/0095 and application deployment remain separate prerequisites before feature activation.

Review and submit selected text drafts through the existing operator workflow. Sync actual provider results and activate usable counterparts without making them ordinary defaults. Review the matching image-twin plans before separately authorizing **Create missing twins**: this uploads a neutral approval sample and submits live templates to Meta. Sync and activate only approved compatible twins. Runtime merchant images continue using the existing banner URL; a new merchant logo does not require a new shared template.

Shared-number readiness requires the exact selected three-button text counterpart and, when branding is enabled, its usable matching image twin. Settings and branding changes revalidate this. Later degradation retains the established safe ordinary confirmation fallback, including a working ordinary branded path, and exposes a readiness reason. Media rejection may use one bounded fallback to the corresponding text parent with identical buttons; unknown outcomes are reconciled rather than resent blindly.

Merchant-owned numbers support independently approved text copies only. Image twins are not provisioned to merchant accounts. A configured logo neither makes that sender branded nor blocks its three-button text activation.

## Prerequisites and delivery order

1. Deliver additive migrations through the normal migration mechanism, in journal order: `0092_change_requests.sql`, `0093_change_request_messaging.sql`, `0094_change_request_reconfirmation.sql`, then `0095_change_request_notifications.sql`. No additional migration is needed for the release verification tooling. Do not edit/revert applied migrations.
2. Deploy compatible backend readers, inbound handlers and all automation workers before any merchant can send a new three-button message. Replace old worker instances too: removing queued jobs alone is insufficient; execution-time guards must be active. Keep merchant opt-in off during this boundary.
3. Verify the existing PostgreSQL and Redis infrastructure and workers: `verification-automation` (request effects, acknowledgement recovery and updated confirmations), `commerce-outcome-sync` (source retries), and the existing webhook/billing recovery paths. When `META_WEBHOOK_DURABLE_ENABLED` is enabled, its intake and `meta-webhook-processing` consumer must both run. The existing minute sweep recovers durable request effects; no merchant reminder or escalation schedule is introduced.
4. Deploy the compatible frontend and verify both standalone and embedded experiences before merchant activation. Keep handling for legacy two-button messages and already-sent current-cycle three-button messages throughout delivery.
5. Verify email infrastructure using the existing `EMAIL_ALERTS_ENABLED`, `RESEND_API_KEY`, `EMAIL_FROM` and `FRONTEND_DASHBOARD_URL` configuration and an actual usable sender domain. Shopify Admin links also require the existing `SHOPIFY_API_KEY`. Check the configured notification address or account-owner fallback. Do not print credentials or inspect application secret files to establish readiness.
6. Preserve existing `WOOCOMMERCE_OUTCOME_SYNC_ENABLED` and `EASYORDERS_OUTCOME_SYNC_ENABLED` controls and merchant outcome settings. Shopify uses the existing adapter; standalone has no external platform operation. Salla and Zid are not implemented sources.

## Template readiness and activation

Use the existing authorized template authoring, submission, reconciliation and provisioning workflow. Migration drafts are not approvals. Keep predecessors available for ordinary messages; do not make a three-button counterpart an ordinary language default or retire a predecessor to activate this feature.

For each merchant's selected language/style, initial template and enabled follow-up variant, record the real registry key, provider language/name, approval/category, synchronization/drift state and actual selected sender. Enumerate variants from the catalog and `changeRequestReadiness.variants`, including automatic language/Arabic-style branches; do not assume one English approval covers the others.

| Sender | Required external evidence |
| --- | --- |
| Shared Akeed number | Approved, active, synced, usable utility counterpart with compatible variables and exactly Confirm → Cancel → Request a change quick replies in the selected language/style. |
| Merchant-owned number | Independently provisioned and approved compatible counterpart on that merchant's actual connection, with valid generation, synchronization and no blocking drift. Shared approval alone is insufficient. |

The catalog spans Arabic and its registered styles, English, Urdu, Spanish, French and Turkish. Draft-only variants, including Turkish where approval is absent, remain unavailable. Three-button sending uses the approved text counterpart; optional image twins follow the existing separate workflow. The selected sender, provider language and style must match; do not switch sender/language to obtain readiness.

`GET /api/settings` exposes `changeRequestsEnabled` and `changeRequestReadiness`. Owners/admins enable through the existing `PATCH /api/settings` flow only after readiness is true. Backend activation failures return `CHANGE_REQUEST_TEMPLATES_UNAVAILABLE`. An unavailable template must never be marked approved to complete a smoke test. Each merchant opts in independently.

## Manual smoke procedure

Use authorized local/staging synthetic orders and test-provider facilities. Record source, sender connection, language/style, order, cycle, provider references and observed results. The application integration runner uses fake transports and does not substitute for this provider check.

1. With opt-in off, verify an ordinary two-button confirmation and its Confirm/Cancel behavior. Attempt activation with an unusable sender-specific counterpart and observe the backend/UI readiness block.
2. After actual readiness and explicit merchant opt-in, send an awaiting, unshipped COD order and tap Change. Observe one persisted request, stopped reminders/no-reply cancellation, one immediate originating-sender acknowledgement, initial email and dashboard/filter entry. Shopify must show `Akeed: Change Requested` while preserving unrelated tags.
3. Repeat the tap/event. Verify no second request, acknowledgement, initial email or charge. Use another merchant with the same customer number to verify isolation. An email deep link must require authentication and another tenant must receive no order data.
4. On separate requests, test current-cycle customer Confirm and Cancel before merchant contact, then owner/admin confirm and cancel after contact. Each closes the task with the right audit reason and follows the existing source synchronization settings. Viewers cannot mutate.
5. Edit the authoritative order address/items/total. The edit alone leaves the request open. Resend must use those fresh details and normal quiet-hour/allowance rules. Only provider acceptance starts the new cycle and timers; old buttons must be ignored. Queued/failed/blocked resends leave the task open and automation stopped.
6. Test zero allowance: request, dashboard and email remain actionable; acknowledgement is recorded skipped. A later top-up must not send/debit the skipped acknowledgement. During quiet hours only the immediate change acknowledgement bypasses the wait.
7. Disable opt-in after sending a three-button confirmation. Future messages use two buttons; valid current-cycle previously sent buttons and existing open requests still work. Reject known-shipped requests; permit unknown shipping status when awaiting confirmation.
8. Check Arabic/Urdu RTL and mobile, both skins, standalone themes, failed notification/resend/sync states and contact links. Opening WhatsApp/call must not cause an Akeed send.

## Monitoring and recovery

Observe the tenant-scoped request acknowledgement/email status and reason, request history, reconfirmation state and existing `remote_sync` status/retry control. Structured backend logs provide transition/error codes without customer payloads. Provider acceptance is not inbox delivery, customer receipt or confirmed external fulfillment prevention.

- Queue interruption: recover the existing durable effects with the minute sweep; do not create a second logical request/notification.
- Email: correct missing configuration/recipient first. Only effects with `first_attempt_at IS NULL` may be returned to pending after correction under the existing support procedure. Preserve frozen payloads and idempotency keys after an attempt. Never replay accepted email. Expired uncertain attempts require provider reconciliation; do not blindly resend beyond the protected replay window.
- Messaging: use existing dispatch reconciliation/refund semantics. Unknown outcomes are parked, not retried as a new paid message. Zero-allowance skips are terminal even after top-up; no paid-template fallback is introduced when the service reply window expires.
- Source synchronization: use the existing tracked retry action. Reconcile current request/cycle state so old jobs cannot restore a resolved request marker. Do not infer resolution from an order edit or tag echo.

## Rollback

Disable `changeRequestsEnabled` through existing authorized settings for affected merchants to stop new three-button selection. There is no dedicated global change-request flag. Confirm future sends select ordinary templates. Retain compatible backend handlers, all request consumers, dashboard resolution controls and migrations for already-sent buttons/open requests. Continue effect/reconciliation recovery and existing platform sync. Do not roll back to code that cannot understand the persisted requests, dispatch kinds or cycles, and do not clear requests, audit records or ledger entries.
