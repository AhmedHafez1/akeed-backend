# US-04-01 manual order creation evidence

**Validated:** 2026-09-04  
**Revision:** backend and frontend working trees  
**Decision:** implemented locally; release remains blocked by the dependent Standalone lifecycle and target-environment validation

## Implemented behavior

- Added session-authenticated `POST /api/orders` with a required `Idempotency-Key` header and a thin, whitelisting controller.
- Owner/admin authorization runs in the service before source lookup, persistence, dispatch, quota effects, or provider effects. Viewers are denied with `MANUAL_ORDER_ROLE_REQUIRED`.
- Organization and integration identity are derived from the freshly authenticated membership and the organization's single active source. Forged authority fields are removed and never reach persistence.
- Phone, positive decimal amount, currency, payment method, and optional names/references use one normalized command contract with stable field errors.
- Readiness fails closed for no active source, multiple active sources, non-Standalone sources, incomplete onboarding, and unavailable entitlement.
- One transaction persists the normalized order and durable processing intent. The existing source-scoped event uniqueness and order uniqueness make matching retries replay-safe; changed normalized content conflicts.
- Post-commit queue failure does not erase or misreport the durable acceptance. The response says `accepted`, not sent/delivered, and may include a verification ID only if one already exists.
- The frontend API layer carries the idempotency header and typed response, stable codes, and field errors without adding the US-04-02 form early.
- The E02/E03 release gate now regenerates ignored Next route types immediately before frontend typecheck, avoiding stale custom dev-build declarations.

## Validation results

| Check | Result |
| --- | --- |
| Manual-order service and HTTP tests | PASS — 2 suites, 17 tests |
| PostgreSQL manual-order concurrency contract | PASS — 1 suite, 5 tests |
| Full backend Jest regression | PASS — 54 suites, 590 tests |
| Backend build | PASS |
| Backend non-fixing ESLint | PASS — 0 errors; 19 pre-existing unsafe-argument warnings in tests |
| Backend structured-log check | PASS — 0 violations |
| Frontend application typecheck | PASS |
| Frontend dual-mode fixture typecheck | PASS |
| Frontend lint | PASS |
| Frontend isolated production build | PASS |
| E03 compatibility gate | PASS |
| Authenticated Standalone target-environment creation smoke | NOT RUN — requires deployed owner/admin/viewer identities and a ready pilot source |
| Standalone processing, WhatsApp send, and callback lifecycle | NOT RUN — owned by US-04-03 and provider release gates |

The PostgreSQL wrapper created a disposable local PostgreSQL 17 database and never used the application database. It proves one winner under concurrent identical submissions, stable replay, changed-payload conflict, atomic rollback, durable dispatch intent, and tenant/source-scoped keys.

## Rollout and recovery

Use [Standalone manual order creation](MANUAL_ORDER_CREATION.md) as the interface and operations contract. Deploy only after US-04-02 through US-04-05 and inherited external gates pass. If durable acceptance fails before commit, clients retry the same normalized submission with the same key. If dispatch fails after commit, preserve the order/event and use normal event recovery; never create a replacement order with a new key merely to bypass recovery.

Rollback is application-only: remove endpoint exposure while preserving all accepted order/event records for audit and replay. No schema rollback is required.

## Remaining release blockers

- Implement and validate the localized accessible entry UI in US-04-02.
- Implement the Standalone normalizer and shared verification lifecycle in US-04-03; current workers register Shopify normalization only.
- Complete dashboard/action coverage and merchant acceptance in US-04-04 and US-04-05.
- Run authenticated target-environment owner/admin/viewer, retry, queue-recovery, and tenant-isolation smoke tests.
- Complete authorized Meta send/callback and inherited Shopify/provider regression evidence before release.
