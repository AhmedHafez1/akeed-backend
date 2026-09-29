# Standalone onboarding v2 — backend

Date: 2026-09-29

Design: [standalone-onboarding-v2.md](standalone-onboarding-v2.md)

## Flow

Before: the standalone onboarding asked for confirmation rules and a review step. New sources were provisioned with follow-up off, and the store name started empty.

After: signup → email verification → "Your store" (`PATCH /api/onboarding/settings`) → free test on the merchant's own WhatsApp (`POST /api/onboarding/test`) → `POST /api/onboarding/complete` once the test is confirmed, skipped, or WhatsApp is unavailable.

## Delivered boundary

Backend:

- `OnboardingStateService.prefillStoreNameIfMissing` fills an empty standalone store name from the organization name (the signup `company_name`), trimmed and capped at 60 characters. An existing store name is never overwritten, and a blank organization name leaves it empty. Shopify still prefills from the platform shop name.
- `provisionStandaloneSourceForOrganization` inserts new standalone sources with `STANDALONE_SOURCE_DEFAULTS`: auto-verify on, `sendDelayMinutes` 0, follow-up on after 120 minutes, escalation on after 360 minutes, quiet hours off, `assumeCodWhenPaymentMissing` false. The transaction, advisory lock and `onConflictDoNothing` retry path are unchanged. Existing rows are not migrated.
- `PATCH /api/onboarding/settings` needed no change. It already accepts and persists `merchantWhatsappPhone` (E.164, `400 ONBOARDING_INVALID_PHONE`), `shippingCurrency` (canonical currency allowlist, class-validator `@IsIn`) and `timezone` (`AUTOMATION_TIMEZONES`, `400 SETTINGS_TIMEZONE_UNSUPPORTED`). The timezone list already covers Africa/Cairo and every served market (EG, SA, AE, QA, KW, BH, OM, JO, MA), so no zone was added.
- `POST /api/onboarding/test` needed no change. The onboarding mode is billing-exempt: no plan slot check and no prepaid-credit claim, and it works while onboarding is `pending`.
- `POST /api/onboarding/complete` needed no change. It keeps the existing blockers, including `account_suspended`. It does not require a confirmed or skipped test; the frontend decides when to call it.

Shopify: no embedded code path changed. The Shopify prefill branch and every shared endpoint behave as before.

No migration.

## Tests added

| Spec | Covers |
| --- | --- |
| `onboarding-state.service.spec.ts` | Standalone prefill from the org name, existing name kept, blank org name, 60-character cap, Shopify prefill unchanged; standalone settings persist phone, currency and `Africa/Cairo`; `Europe/London` and an invalid phone rejected; DTO rejects `GBP` |
| `onboarding.service.spec.ts` | `/complete` succeeds after the "Your store" settings are saved on a source with the v2 defaults; still `409 ONBOARDING_BLOCKED` with `account_suspended` |
| `onboarding-test.service.spec.ts` | Standalone pending source sends in onboarding mode with the `SAR` shipping currency in the order and the sample; `400 ONBOARDING_TEST_PHONE_MISSING` without a number |
| `verification-message-dispatches.repository.spec.ts` | A billing-exempt claim on a standalone source in prepaid-credit mode touches no credit or usage table |
| `standalone-organization-provisioning.repository.spec.ts` | The integrations insert carries every v2 default |
| `test/standalone-provisioning.contract-spec.ts` | Provisioned row on PostgreSQL has the v2 defaults (expectation updated from `followUpEnabled: false`) |

## Validation results

| Check | Result |
| --- | --- |
| Backend `npx tsc --noEmit -p tsconfig.json` | PASS |
| Backend `npx eslint` on the touched files | PASS: 0 errors; 4 existing `no-unsafe-argument` warnings in `onboarding-state.service.spec.ts`, same as before |
| Backend `npm run build` | PASS |
| `npm run log:check` | PASS: 0 violations |
| Backend `npm run test` | 146 of 147 suites, 3819 of 3820 tests pass. The failure is `release-gate-architecture.spec.ts` ("has no import-specific retry, cancel or order-list route": expected 13 routes, found 14). It fails the same way on a clean `develop` checkout and is not related to this change. |
| `npm run test:contract:e045` (disposable PostgreSQL 17) | PASS: credit-foundation 40, standalone-provisioning 10, credit-usage 22, paymob-checkout 29, billing-operations 38, billing-observability 31 |

`npm run lint` was not run: it runs `eslint --fix` across the whole tree. ESLint ran on the touched files only.

## Not run

- No migration was applied to any shared database; none is needed.
- No live WhatsApp send or authenticated signup against hosted Supabase.
- Frontend: the v2 screens are a separate change.
