# US-03-04 Standalone test verification evidence

**Validated:** 2026-09-04  
**Revision:** backend and frontend working trees  
**Decision:** local implementation passes; release remains blocked by authenticated pilot and live Meta validation, the inherited E02 gate, and unfinished US-03-05

## Implemented behavior

- `POST /api/verifications/test` now resolves the trusted current commerce source instead of requiring Shopify. Shopify embedded sessions resolve their authenticated shop identity; Supabase sessions resolve the organization's single active source. The send command remains source-neutral for Standalone, Shopify, and future commerce adapters.
- Supabase owner/admin memberships may send. Viewers and missing memberships receive `403 TEST_VERIFICATION_ROLE_REQUIRED` before source resolution or provider activity.
- Every test is exactly one immediate WhatsApp message. Test delivery bypasses auto-verification, configured first-send delay, quiet hours, follow-up, and no-reply scheduling for every commerce source. It still uses the shared messaging service and atomically reserves the normal plan quota.
- Phone, source, entitlement, onboarding, provider, and rate-limit failures expose stable/actionable states. Provider rejection returns `502 TEST_VERIFICATION_PROVIDER_FAILED`; the API never reports success when the immediate shared sender reports failure.
- Synthetic IDs use the collision-safe `akeed-test-<uuid>` convention. Persisted orders have `is_test = true` and explicit synthetic payload metadata. The dashboard DTO exposes `is_test`, and both dashboard skins render a localized Test badge.
- Synthetic callbacks update only Akeed's local verification state. Confirmation/cancellation callbacks do not dispatch a commerce outcome. Existing Shopify adapter suppression remains defense in depth.
- The panel has a synchronous in-flight lock in addition to disabled loading state, preventing repeat clicks before React rerenders. Phone validation, success, quota, source, role, setup, provider, rate-limit, and generic failure states are localized in Arabic and English. Success copy explicitly says no real order was created or updated.
- The shared international phone input now renders its existing label as a real accessible label and exposes invalid state. Arabic continues to inherit the application's RTL direction and logical spacing.
- The existing global request throttle (60 requests per minute) remains active; the normal verification quota is also enforced. No token or credential logging was added.

No database migration is required for this story.

## Validation results

| Check | Result |
| --- | --- |
| Focused test/source/hub/repository regression | PASS — 4 suites, 90 tests |
| Full backend Jest regression | PASS — 52 suites, 565 tests |
| Backend build | PASS |
| Backend structured-log check | PASS — 0 violations |
| Backend non-fixing ESLint | PASS — 0 errors; 19 pre-existing unsafe-argument warnings in older tests |
| Frontend application type-check | PASS |
| Isolated fixture type-check | PASS |
| Frontend lint | PASS |
| Frontend production build | PASS |
| Changed frontend file formatting | PASS |
| Authenticated owner/admin/viewer locale smoke | NOT RUN — requires deployed pilot identities |
| Live Meta send and callback | NOT RUN — intentionally requires an authorized test recipient and target environment |

The automated tests cover a valid Standalone send, shared Shopify/future-source behavior, unauthorized viewer, invalid phone, missing source, missing entitlement, provider failure, quota exhaustion, immediate-mode automation bypass, and zero commerce outcome dispatch for synthetic callbacks. No Shopify API, Meta API, real order, application database, or customer number was used by local tests.

## Basic test procedure

1. Deploy the compatible backend and frontend after US-03-01 through US-03-03, then activate only an approved Standalone pilot entitlement.
2. Sign in as the organization owner in English. Enter an authorized WhatsApp test number and press Send twice rapidly. Confirm only one request/message is produced, the control stays disabled while pending, and the localized success says no real order was created or updated.
3. Confirm the row is labelled Test, usage increases by one, and no initial-delay, quiet-hours, follow-up, or no-reply job is created.
4. Reply to the test message. Confirm the dashboard callback state changes but no external commerce action or Shopify request is dispatched.
5. Repeat as admin, then as viewer. Owner/admin should send; viewer should receive the localized role error and produce no send.
6. Repeat the critical path in Arabic. Confirm `lang=ar`, `dir=rtl`, keyboard operation, phone validation, loading state, feedback, and Test badge.
7. Exercise invalid phone, inactive/missing source, missing entitlement, exhausted quota, and a controlled provider failure. Confirm each response is actionable and none performs a Shopify lookup.
8. Repeat one valid test from Shopify embedded mode. Confirm it also sends exactly once immediately and the existing embedded dashboard remains intact.

## Deployment, monitoring, and recovery

Deploy backend and frontend together because the UI uses new structured error codes and the verification list adds `is_test`. Begin with one authorized owner recipient, then add the approved admin/locale cases. Do not use customer numbers for rollout checks.

Monitor `TEST_VERIFICATION_ROLE_REQUIRED`, `TEST_VERIFICATION_SOURCE_UNAVAILABLE`, `TEST_VERIFICATION_SOURCE_AMBIGUOUS`, `TEST_VERIFICATION_ENTITLEMENT_REQUIRED`, `TEST_VERIFICATION_SETUP_INCOMPLETE`, `TEST_VERIFICATION_PROVIDER_FAILED`, HTTP 429 responses, plan-limit skips, and verification send failures. Logs contain organization/integration/verification identifiers but no access tokens or full provider credentials.

If failures rise, stop pilot testing and roll back the backend and frontend together. Synthetic records are retained as test history and usage truth; do not relabel them as real orders or manually alter quota. No schema rollback is needed.

## Remaining release blockers

- Complete an authenticated owner/admin/viewer English/Arabic smoke in the target environment.
- Complete one authorized live Meta send/callback and verify provider delivery plus zero external commerce actions.
- Complete the inherited US-02-07 staging/authenticated dual-mode gate and deploy/reconcile US-03-01 through US-03-03.
- Complete US-03-05 before the E03 release gate.
