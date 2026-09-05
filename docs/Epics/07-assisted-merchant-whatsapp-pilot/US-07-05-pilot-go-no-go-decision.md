# US-07-05 — Evaluate the merchant WhatsApp pilot

- **Epic:** [E07 — Assisted Merchant-Owned WhatsApp Pilot](README.md)
- **Delivery rank:** 5 of 5
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Quality gate
- **Status:** Backlog
- **Dependencies:** [US-07-04](../07-assisted-merchant-whatsapp-pilot/US-07-04-pilot-support-and-recovery-drills.md)

## User story and value

As a founder and product owner, I want a measured expand, hold or stop decision, so that self-service investment follows evidence about merchant value and support cost.

**Business value:** Self-service investment follows evidence about merchant value and support cost.

## Scope

Pilot review covering eligibility, reliability, adoption and operations.

**Out of scope:** Automatically launching full Embedded Signup or broad merchant migration.

## Acceptance criteria

1. The review compares actual cohort outcomes with the measurements recorded in US-07-01, including eligibility success and onboarding/support time.
2. All pilot merchants have a verified send/reply/status path and completed required recovery checks before being counted successful.
3. Unintended cross-tenant effects, wrong-sender sends and duplicate business effects have zero unresolved occurrences at an expand decision.
4. Failures, number/coexistence limitations, template burden and support costs are reported with evidence rather than hidden in averages.
5. Product/operations record expand, hold or stop, residual risks and next actions; self-service remains separate unapproved implementation scope.

## Implementation notes

- **Backend:** Export safe operational aggregates from connection/dispatch state without broad PII export.
- **Frontend:** Collect structured merchant feedback on readiness and error clarity in the pilot's supported languages.
- **Data:** Reconcile outcome counts with underlying records and document unknown delivery/eligibility cases.
- **Operations:** Keep the approved pilot cap until the decision is recorded; pause any unsafe connection regardless of commercial interest.

## Test requirements

- Audit a sample of metrics against message/connection records and verify incident closure evidence.
- Review E06 regression results and E07 checklist completeness.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

A hold/stop retains historical data and allows explicit safe disconnection; an expand decision is not authorization to build deferred self-service.

## Evidence and references

**VERIFIED FROM CODE:** There is no repository evidence of a validated tenant-owned-number operating model; production readiness must come from the pilot.

- [akeed-backend/src/infrastructure/spokes/meta/whatsapp.service.ts](../../akeed-backend/src/infrastructure/spokes/meta/whatsapp.service.ts)
- [akeed-backend/src/infrastructure/spokes/meta/whatsapp.webhook.service.ts](../../akeed-backend/src/infrastructure/spokes/meta/whatsapp.webhook.service.ts)
- [akeed-backend/src/infrastructure/database/repositories/verifications.repository.ts](../../akeed-backend/src/infrastructure/database/repositories/verifications.repository.ts)

**ASSUMPTION / REQUIRES VALIDATION:** Acceptance criteria above describe approved proposed work, not completed functionality. Resolve any implementation discovery against the epic exit criteria; do not silently expand scope.

**EXTERNAL PLATFORM DEPENDENCY:** Revalidate relevant provider behavior before enabling live traffic. These primary sources are reference inputs, not proof of this integration's readiness.

- [Meta — WhatsApp Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api)
- [Meta Blueprint — Embedded Signup](https://www.facebookblueprint.com/student/path/253152-whatsapp-embedded-signup-course)

