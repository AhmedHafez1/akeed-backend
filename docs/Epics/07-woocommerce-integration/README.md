# E07 — WooCommerce Integration

- **Horizon:** NEXT
- **Status:** Backlog (epic refactored 2026-10-04; no story started)
- **Stories:** 6
- **Prerequisite epics:** [E02 — Platform Boundaries and Reliability](../02-platform-boundaries-and-reliability/README.md), [E03 — Standalone Foundation and Onboarding](../03-standalone-foundation-and-onboarding/README.md), [E05 — Standalone Order Ingestion API](../05-standalone-order-ingestion-api/README.md), and the shared code that [E06 — EasyOrders Integration](../06-easyorders-integration/README.md) put on `develop` (US-06-02 to US-06-05) with its automated gate. E06 go-live is **not** a prerequisite.
- **Roadmap:** [Expansion backlog](../README.md)
- **Implementation prompts:** [IMPLEMENTATION-PROMPTS.md](IMPLEMENTATION-PROMPTS.md)

## Refactor note (2026-10-04)

The epic was rewritten on 2026-10-04 after E06 was built. What changed and why:

- **No validation spike.** EasyOrders needed one because its provider contract had material unknowns. WooCommerce has a documented REST and webhook contract, so US-07-01 is now a contract-and-plan story written from the official docs, and live proof is the US-07-06 release gate.
- **No hosting matrix.** A stated support boundary replaces the "supported-store matrix".
- **Decoupled from E06 go-live.** US-06-06 is release-blocked on EasyOrders provider questions that WooCommerce does not depend on. E07 depends on the E06 shared code and its automated gate only.
- **Stories rewritten against the code as it is now.** The earlier E07 notes said only Shopify had a normalizer, that onboarding was Shopify-specific and that a common outcome registry had to be preserved. E06 left reusable extension points for all three; each story now names them.

Story filenames now follow their titles; the renamed files preserve the existing US-07 story IDs.

## Business objective

Add WooCommerce as a spoke on the shared hub contracts, built from WooCommerce's documented REST and webhook contract and proven on a real store before any merchant is enabled.

## Scope and boundaries

Contract record and implementation plan, application-auth connection, signed webhook ingestion, outcome synchronization, setup/health/disconnect with a support runbook, and a release gate with a live run on a real store.

**Out of scope:** a WordPress plugin; a hosting or version compatibility matrix; plain-HTTP stores; credentials in query strings; manual consumer key/secret entry; custom order statuses and non-core payment gateways; historical import, polling and backfill of missed events; source switching; a tenant-owned WhatsApp sender; credit billing for connected stores.

## Approved product decisions (product owner, 2026-10-04)

| # | Decision |
| --- | --- |
| 1 | E07 depends on the E06 shared code and automated gate, not on E06 go-live. |
| 2 | Customer confirmation writes an order note and an Akeed meta marker to WooCommerce and changes no status. WooCommerce has no "confirmed" status; `processing` is already where a placed COD order sits and `completed` means fulfilled. |
| 3 | Customer cancellation and merchant no-reply cancellation write `cancelled`. The side effects (stock restored, cancellation email) are accepted. |
| 4 | Automatic no-reply stays local. It never cancels an order in WooCommerce. |
| 5 | Connection is WooCommerce application authentication only. No manual key entry. |
| 6 | WooCommerce pilot organizations get the same pilot entitlement as EasyOrders (Starter, billing `not_required`). Charging connected stores is separate billing work. |
| 7 | Orders placed while a webhook was disabled, or while the source was not ready, are not imported later. This is a stated limit. |

## Validation rule

Documented WooCommerce behavior is the contract. A finding is **UNKNOWN** only where the official docs are silent, and each UNKNOWN carries a worst-case rule that the code follows. Nothing is filled in by assumption. If the build or the release gate contradicts the contract record, one focused validation story is opened and only the affected story is reopened. There is no upfront discovery phase.

## Prioritized user stories

Delivery rank is the execution order. Dependencies override priority; P1 enablement remains in this epic and must be complete before the final gate when that gate relies on it. All stories start in Backlog.

| Rank | Story | Priority | Type | Direct dependencies | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | [US-07-01 — WooCommerce integration contract and implementation plan](US-07-01-woocommerce-integration-contract-and-implementation-plan.md) | P0 | Contract and plan | [US-02-07](../02-platform-boundaries-and-reliability/US-02-07-platform-boundary-release-gate.md), [US-03-05](../03-standalone-foundation-and-onboarding/US-03-05-standalone-tenant-and-primary-source-guards.md), [US-05-06](../05-standalone-order-ingestion-api/US-05-06-api-security-and-recovery-release-gate.md), E06 shared code on `develop` | Backlog |
| 2 | [US-07-02 — Connect WooCommerce through application authentication](US-07-02-connect-woocommerce-through-application-authentication.md) | P0 | Feature | [US-07-01](US-07-01-woocommerce-integration-contract-and-implementation-plan.md) | Backlog |
| 3 | [US-07-03 — Ingest signed WooCommerce order webhooks](US-07-03-ingest-signed-woocommerce-order-webhooks.md) | P0 | Feature | [US-07-02](US-07-02-connect-woocommerce-through-application-authentication.md) | Backlog |
| 4 | [US-07-04 — Apply approved verification outcomes in WooCommerce](US-07-04-apply-approved-verification-outcomes-in-woocommerce.md) | P0 | Feature | [US-07-03](US-07-03-ingest-signed-woocommerce-order-webhooks.md) | Backlog |
| 5 | [US-07-05 — WooCommerce setup, health, disconnect and support](US-07-05-woocommerce-setup-health-disconnect-and-support.md) | P1 | Feature | [US-07-04](US-07-04-apply-approved-verification-outcomes-in-woocommerce.md) | Backlog |
| 6 | [US-07-06 — WooCommerce release gate and pilot](US-07-06-woocommerce-release-gate-and-pilot.md) | P0 | Quality gate | [US-07-05](US-07-05-woocommerce-setup-health-disconnect-and-support.md) | Backlog |

## Measurable exit criteria

- The US-07-01 contract record has no blocking UNKNOWN on authenticity, tenant resolution or secret handling.
- The shared conformance matrix and the WooCommerce-specific fixtures pass against a WooCommerce provider fake.
- One real WooCommerce store completes connect → COD order → webhook → Akeed WhatsApp → confirm, and cancel, with the approved result visible in WooCommerce; duplicate delivery, a non-COD order and disconnect/reconnect are exercised on it.
- Shopify, Standalone (manual, import, API) and EasyOrders automated regressions pass.
- Every story meets its acceptance criteria and the [shared Definition of Done](../README.md).

## Dependency and rollout notes

Stories 02 to 05 ship behind their own switches, all off, with a pilot allow-list, as E06 did. Native pilots use fresh or unprovisioned organizations, never active-source replacement.
A store outside the support boundary in the contract record is refused with a clear message; it is not silently enrolled.
No calendar estimate or staffing commitment is implied by priority.

## Evidence discipline

The product sequence and the decisions above are approved; all implementation remains proposed. Story-level links distinguish code evidence from documented provider behavior and from assumptions. The baseline for shared code is the E06 evidence dated 2026-10-03 ([release gate](../06-easyorders-integration/evidence/US-06-06-release-gate.md)), not a fresh test run.
