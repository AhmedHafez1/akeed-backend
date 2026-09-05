# US-04-05 — Standalone merchant acceptance evidence

**Evidence date:** 2026-09-05  
**Decision:** Implemented locally — release blocked  
**Backend HEAD:** `99373ad` (working tree contains the US-04-04 and US-04-05 changes)  
**Frontend HEAD:** `07ad8f7` (working tree contains the US-04-04 and select-layout changes)

This record deliberately separates local implementation evidence from target-environment release evidence. No production migration, tenant repair, credential capture, or unapproved provider action was performed.

## Results

| Gate | Result | Evidence / limitation |
| --- | --- | --- |
| Composed Standalone acceptance harness | PASS | `npm run test:acceptance:e04`: 1 suite, 6 tests. Covers test send, manual COD acceptance, worker processing, customer confirmation and duplicate callback, Redis/dispatch recovery, invalid phone, viewer denial, inactive source, revoked session, non-COD ineligible, provider uncertainty, concurrent idempotency, changed replay conflict, forged source IDs, and cross-tenant retry denial. |
| Shopify isolation sentinel | PASS | The composed harness wires a Standalone adapter and a Shopify sentinel; the happy-path confirmation completed with zero Shopify calls. |
| Manual-order PostgreSQL contract | NOT RUN | `npm run test:contract:manual-orders` stopped before tests because `E01_TEST_DATABASE_URL` was not configured. The contract refuses to use the application `DATABASE_URL`. |
| Inherited E03/E02 regression | FAIL / RELEASE BLOCK | `npm run test:gate:e03` ran serially. E02 core passed 7 suites / 116 tests; the Shopify adapter contract passed 26 tests; the full backend regression passed 59 suites / 642 tests. The gate then stopped at the platform migration rehearsal because `docker` is unavailable in this environment. E03/E02 target validation remains open. |
| Backend build | PASS | `npm run build`. |
| Backend non-fixing lint | PASS | `npx eslint "{src,apps,libs,test}/**/*.ts"`; 0 errors and 19 pre-existing unsafe-argument warnings. |
| Frontend application typecheck | PASS | `npx next typegen` and `npx tsc --noEmit --pretty false`. |
| Frontend isolated fixture typecheck | PASS | `npm run smoke:e02:typecheck`. |
| Frontend lint | PASS | `npm run lint`. |
| Frontend isolated production build | PASS | `NEXT_DIST_DIR=.next/e04-validation-build npm run build`; generated type paths were removed from `tsconfig.json` after the check. |
| Select layout regression | PASS / PARTIAL | Live Chrome LTR screenshot confirmed the date-range chevron is centered in a reserved gutter. RTL-safe logical padding and `end-*` positioning are covered in code and typechecked; Chrome became unavailable during the hot-reload Arabic navigation, so no RTL screenshot is claimed. |
| Authenticated owner/admin/viewer walkthrough | NOT RUN | The available authenticated Chrome session was owner-like, but its Standalone source reported disconnected and the `New order` action was disabled. No role switching or mutation was attempted. |
| Authorized live Meta pilot | NOT RUN / RELEASE BLOCK | The approved recipient was supplied, but the authenticated target currently reports a disconnected source and verification paused. No new live message or manual order was submitted. An existing masked test row was observed; it is not counted as this pilot. |

## Synthetic reconciliation

The passing composed suite uses an in-memory store and provider fakes, not the application database. In the happy path it records one manually accepted order, one manual verification, one logical initial dispatch/usage reservation, one accepted provider message, and one customer confirmation. Replaying the callback leaves the verification and Standalone outcome adapter at one application. The test-send flow is separately synthetic and is not mixed into the manual-order count. Redis dispatch failure leaves the durable event pending and a later worker delivery creates no duplicate verification, provider message, or usage reservation.

## Scope covered by local evidence

- `POST /api/orders` acceptance and `Idempotency-Key` replay semantics.
- Standalone webhook normalization and `WebhookQueueProcessor` delivery/retry behavior.
- Shared verification eligibility, usage reservation, provider failure preservation, and WhatsApp callback finalization.
- Viewer/write-role denial, session revocation, source identity checks, cross-tenant retry denial, and forged request source fields.
- `ineligible`, `pending`/accepted, `failed`, `review_required`, and local recovery paths are covered by the composed harness and inherited lifecycle/adapter tests. `no_reply` and merchant local cancellation are covered by the inherited verification automation, outcome registry, and frontend fixture suites; the authenticated target walkthrough is still open.

## Required release closure

US-04-05 and E04 remain release-blocked until all of the following are rerun successfully against approved disposable contract infrastructure and the authorized target:

1. Set a dedicated local `E01_TEST_DATABASE_URL` for the PostgreSQL contract; never substitute the application database.
2. Restore/verify the target Standalone source connection and active entitlement, then complete the one-recipient Meta pilot using the supplied recipient. Record only masked identifiers and counts.
3. Exercise authenticated owner/admin/viewer journeys in English and Arabic, including LTR/RTL, keyboard focus, pending-submit locking, timeout/network recovery, dashboard filters/pagination, retry, no-reply cancellation, and Shopify embedded regression.
4. Rerun `npm run test:gate:e04` serially and attach the successful contract, inherited E01/E02/E03, backend, frontend, and browser outputs.

## Support recovery and rollback

For an accepted-but-unsent order, preserve the accepted order/event and dispatch history, inspect the dispatch state and provider uncertainty, and use the existing local retry only when lifecycle policy permits it. `review_required` / `provider_outcome_unknown` requires reconciliation before retry. For a release rollback, disable new manual processing or deploy the prior application/worker version; retain accepted orders, events, dispatches, verifications, and usage history. Do not run production migrations or repair tenant data without target-environment approval and preflight evidence.
