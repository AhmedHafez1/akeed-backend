# US-01-05 — Protect entitlement, automation and the Akeed sender

- **Epic:** [E01 — Shopify Baseline Stabilization](README.md)
- **Delivery rank:** 5 of 6
- **Priority:** P0
- **Horizon:** NOW
- **Story type:** Quality gate
- **Status:** Complete — evidence validated 2026-08-31; US-01-06 gate completed
- **Dependencies:** [US-01-01](US-01-01-deterministic-test-baseline.md)

## User story and value

As a merchant, I want verification scheduling and usage to remain reliable, so that customers are contacted at the right time without unexpected quota consumption.

**Business value:** Customers are contacted at the right time without unexpected quota consumption.

## Scope

Current billing eligibility, usage reservation, delays, follow-ups, quiet hours and environment sender.

**Out of scope:** Tenant-owned credentials or changing existing automation defaults.

## Acceptance criteria

1. Active/not_required billing permits the existing send path; inactive integration, blocked billing and exhausted quota do not send.
2. Known send failures with successful quota release preserve current behavior. Already-sent initial jobs do not send again at the worker boundary. Failed quota release and provider acceptance followed by failed local persistence are separately characterized failure windows; retries are not claimed to guarantee exactly-once delivery or charging. Follow-up failure preserves the original verification state.
3. Follow-ups stop for terminal states; quiet-hour and no-reply scheduling preserve current ordering rules.
4. With only WA_ACCESS_TOKEN and WA_PHONE_NUMBER_ID configured, initial/follow-up calls use the current Akeed sender and templates.

## Implementation notes

- **Backend:** Characterize hub, send service, entitlement and worker interactions using controlled time and mocked provider responses.
- **Frontend:** No UI changes; preserve usage and lifecycle response shapes.
- **Data:** Test usage counters and lifecycle timestamps, including the current single mutable waMessageId behavior.
- **Operations:** Do not contact real phone numbers or load production credentials during tests.

## Test requirements

- Blocked billing/integration, plan limit, failed send, scheduled send, quiet hours and terminal-status follow-up.
- Assert current follow-up message-ID replacement as a migration baseline.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Tests become required before E06 sender changes; document any existing ambiguity rather than hiding it.

## Evidence and references

**Implementation evidence (2026-08-31):** [Entitlement, retry, sender and message-identity checks](../../akeed-backend/docs/E01-BASELINE-EVIDENCE.md). US-06-02 owns durable dispatch/message identity and uncertain-send reconciliation; urgent reproduced reliability defects must be triaged independently of the merchant-owned sender rollout.

**VERIFIED FROM CODE:** Sending uses global environment credentials; follow-up persistence replaces the verification's current message ID.

- [akeed-backend/src/modules/verification-core/verification-send.service.ts](../../akeed-backend/src/modules/verification-core/verification-send.service.ts)
- [akeed-backend/src/modules/verification-core/billing-entitlement.service.ts](../../akeed-backend/src/modules/verification-core/billing-entitlement.service.ts)
- [akeed-backend/src/modules/verification-automation/verification-automation.processor.ts](../../akeed-backend/src/modules/verification-automation/verification-automation.processor.ts)
- [akeed-backend/src/infrastructure/spokes/meta/whatsapp.service.ts](../../akeed-backend/src/infrastructure/spokes/meta/whatsapp.service.ts)
- [akeed-backend/src/infrastructure/database/repositories/verifications.repository.ts](../../akeed-backend/src/infrastructure/database/repositories/verifications.repository.ts)
- [akeed-backend/src/shared/utils/billing.util.ts](../../akeed-backend/src/shared/utils/billing.util.ts)

**VALIDATION BOUNDARY:** The linked evidence records the repeated automated gate, authenticated existing-session checks in both modes/locales, and isolated cancellation feedback. US-01-06 is complete for this recorded working tree. Fresh credential submission/new-account creation, live-provider readiness, recoverable dispatch and exactly-once sending are not claimed. Known E02/E06 reliability work remains open; repeat the gate on the next candidate.

**EXTERNAL PLATFORM DEPENDENCY:** Revalidate relevant provider behavior before enabling live traffic. These primary sources are reference inputs, not proof of this integration's readiness.

- [Meta — WhatsApp Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api)
