# E09 — WooCommerce Integration

- **Horizon:** LATER
- **Status:** Backlog
- **Stories:** 6
- **Prerequisite epics:** [E08 — EasyOrders Integration](../08-easyorders-integration/README.md)
- **Roadmap:** [Expansion backlog](../README.md)

## Business objective

Add a supportable WooCommerce adapter using core APIs and signed webhooks after EasyOrders validates the adapter model.

## Scope and boundaries

Compatibility/auth spike, application auth, secure REST access, signed webhooks, outcome mapping, diagnostics, and pilot qualification.

**Out of scope:** WordPress plugin, arbitrary extensions/custom statuses, source switching, and support for every hosting configuration.

## Prioritized user stories

Delivery rank is the execution order. Dependencies override priority; P1 enablement remains in this epic and must be complete before the final gate when that gate relies on it. All stories start in Backlog.

| Rank | Story | Priority | Type | Direct dependencies | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | [US-09-01 — Validate WooCommerce hosting, authentication and mappings](US-09-01-woocommerce-compatibility-and-auth-validation.md) | P0 | Validation spike | [US-08-06](../08-easyorders-integration/US-08-06-easyorders-contract-and-pilot-release-gate.md) | Backlog |
| 2 | [US-09-02 — Connect WooCommerce through application authentication](US-09-02-woocommerce-application-auth-connection.md) | P0 | Feature | [US-09-01](../09-woocommerce-integration/US-09-01-woocommerce-compatibility-and-auth-validation.md) | Backlog |
| 3 | [US-09-03 — Ingest signed WooCommerce order webhooks](US-09-03-woocommerce-signed-webhook-ingestion.md) | P0 | Feature | [US-09-02](../09-woocommerce-integration/US-09-02-woocommerce-application-auth-connection.md) | Backlog |
| 4 | [US-09-04 — Apply approved verification outcomes in WooCommerce](US-09-04-woocommerce-outcome-status-adapter.md) | P0 | Feature | [US-09-03](../09-woocommerce-integration/US-09-03-woocommerce-signed-webhook-ingestion.md) | Backlog |
| 5 | [US-09-05 — Provide WooCommerce diagnostics and reconnection](US-09-05-woocommerce-diagnostics-and-reconnection.md) | P1 | Feature | [US-09-04](../09-woocommerce-integration/US-09-04-woocommerce-outcome-status-adapter.md) | Backlog |
| 6 | [US-09-06 — Qualify WooCommerce for pilot release](US-09-06-woocommerce-compatibility-and-pilot-release-gate.md) | P0 | Quality gate | [US-09-05](../09-woocommerce-integration/US-09-05-woocommerce-diagnostics-and-reconnection.md) | Backlog |

## Measurable exit criteria

- A documented supported-store matrix passes authentication, REST, and webhook qualification.
- End-to-end order verification and approved outcome synchronization pass on qualified stores.
- Security, revocation, disabled webhooks, retries, and Shopify regressions meet the release gate.
- Every story meets its acceptance criteria and the [shared Definition of Done](../README.md); unresolved platform validation blocks dependent release.

## Dependency and rollout notes

Scheduled after EasyOrders. Qualify a supported store matrix; do not promise every plugin/host combination.
No calendar estimate or staffing commitment is implied by priority.

## Evidence discipline

The product sequence is approved; all implementation remains proposed. Story-level links distinguish code evidence from assumptions and external dependencies. Historical baseline results are dated 2026-08-30 and are not fresh test runs.

