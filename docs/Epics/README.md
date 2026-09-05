# Akeed Expansion — Epics and Prioritized User Stories

**Authored:** 2026-08-31  
**Status:** E01 complete; E02 and E03 implemented locally with external release validation pending; E04 in progress locally (5 of 5 implemented, release blocked); E05–E09 remain backlog  
**Inventory:** 9 epics, 53 user stories (49 P0 / 4 P1), 10 README files  
**Location:** Workspace-level `Epics`, outside both application Git repositories

## Purpose

Translate the approved platform-expansion case study into a delivery-ready backlog, beginning with Shopify protection and ending with WooCommerce. The objective is to accept a normalized COD order from supported sources, apply the shared verification lifecycle, and safely deliver through the Akeed or an explicitly activated merchant sender.

Creating this backlog did not implement code, run migrations, activate connections, send WhatsApp messages, deploy services or update an external project tracker. E01 packages A/B/C and the US-01-06 gate were subsequently completed on 2026-08-31. E02 and E03 were subsequently implemented locally with external release validation pending. E04 has five locally implemented stories as of 2026-09-05, with release closure blocked by the remaining target and infrastructure gates; E05–E09 remain Backlog. See story-level dated evidence for actual revisions, checks, and limitations. No live-provider readiness, exactly-once delivery or deployment is claimed.

## Approved roadmap

| Order | Epic                                                                                            | Horizon | Stories | Prerequisite epics                                                                                                                                                    | Exit gate                                                                                                   |
| ----- | ----------------------------------------------------------------------------------------------- | ------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1     | [E01 — Shopify Baseline Stabilization](01-shopify-baseline-stabilization/README.md)             | NOW     | 6       | None                                                                                                                                                                  | [US-01-06](01-shopify-baseline-stabilization/US-01-06-dual-mode-regression-release-gate.md)                 |
| 2     | [E02 — Platform Boundaries and Reliability](02-platform-boundaries-and-reliability/README.md)   | NOW     | 7       | [E01](01-shopify-baseline-stabilization/README.md)                                                                                                                    | [US-02-07](02-platform-boundaries-and-reliability/US-02-07-platform-boundary-release-gate.md)               |
| 3     | [E03 — Standalone Foundation and Onboarding](03-standalone-foundation-and-onboarding/README.md) | NOW     | 5       | [E02](02-platform-boundaries-and-reliability/README.md)                                                                                                               | [US-03-05](03-standalone-foundation-and-onboarding/US-03-05-standalone-tenant-and-primary-source-guards.md) |
| 4     | [E04 — Standalone Manual Order MVP](04-standalone-manual-order-mvp/README.md)                   | NEXT    | 5       | [E03](03-standalone-foundation-and-onboarding/README.md)                                                                                                              | [US-04-05](04-standalone-manual-order-mvp/US-04-05-manual-mvp-merchant-acceptance.md)                       |
| 5     | [E05 — Standalone Order Ingestion API](05-standalone-order-ingestion-api/README.md)             | NEXT    | 6       | [E04](04-standalone-manual-order-mvp/README.md)                                                                                                                       | [US-05-06](05-standalone-order-ingestion-api/US-05-06-api-security-and-recovery-release-gate.md)            |
| 6     | [E06 — Tenant-Aware WhatsApp Foundation](06-tenant-aware-whatsapp-foundation/README.md)         | NEXT    | 7       | [E02](02-platform-boundaries-and-reliability/README.md)                                                                                                               | [US-06-07](06-tenant-aware-whatsapp-foundation/US-06-07-messaging-isolation-and-fallback-release-gate.md)   |
| 7     | [E07 — Assisted Merchant-Owned WhatsApp Pilot](07-assisted-merchant-whatsapp-pilot/README.md)   | NEXT    | 5       | [E06](06-tenant-aware-whatsapp-foundation/README.md)                                                                                                                  | [US-07-05](07-assisted-merchant-whatsapp-pilot/US-07-05-pilot-go-no-go-decision.md)                         |
| 8     | [E08 — EasyOrders Integration](08-easyorders-integration/README.md)                             | NEXT    | 6       | [E02](02-platform-boundaries-and-reliability/README.md), [E03](03-standalone-foundation-and-onboarding/README.md), [E05](05-standalone-order-ingestion-api/README.md) | [US-08-06](08-easyorders-integration/US-08-06-easyorders-contract-and-pilot-release-gate.md)                |
| 9     | [E09 — WooCommerce Integration](09-woocommerce-integration/README.md)                           | LATER   | 6       | [E08](08-easyorders-integration/README.md)                                                                                                                            | [US-09-06](09-woocommerce-integration/US-09-06-woocommerce-compatibility-and-pilot-release-gate.md)         |

E01 → E02 → E03 → E04 → E05 → E08 → E09 is the commerce delivery sequence. E06 branches from E02 and may proceed alongside E03–E05; E07 follows E06. E08 does not depend on E06/E07 because EasyOrders can use the Akeed sender. E09 is deliberately later than E08.

Every epic has a prioritized story table. Each story's direct dependency links form the minimum execution chain; dependencies are transitive. The last story in each epic is its release/acceptance gate. A gate cannot be marked complete while an acceptance criterion or a required predecessor remains unresolved.

## Priority and status rules

- **P0:** Required capability, prerequisite, security/reliability control or release gate for its epic.
- **P1:** Supporting merchant usability, documentation or operational enablement. Still part of the approved epic; complete it before any gate that depends on it.
- **Horizon is separate from priority:** a P0 WooCommerce story remains LATER, not a reason to displace Shopify stabilization.
- **Delivery rank** is the story order inside its epic. Dependencies override priority labels and prevent release gates from jumping ahead of supporting work.
- IDs such as `US-05-03` are stable. Reprioritize the index/rank deliberately rather than renaming IDs or silently changing dependencies.
- Record implementation and release status separately with evidence. E01 is complete for its recorded working trees; E02 and E03 are implemented locally but release blocked; E04 has all five stories implemented locally but remains release blocked; E05–E09 remain **Backlog**. A validation spike can be Done with a no-go finding while its dependent feature remains Blocked.
- No story points, calendar promises or staffing assignments are fabricated. Those require delivery-team estimation.

## Story format

Each story provides metadata, a user/value statement, scope/exclusions, numbered acceptance criteria, backend/frontend/data/operations notes, test requirements, migration/rollout guidance and linked evidence.

Story types distinguish **Feature**, **Technical enabler**, **Quality gate**, **Validation spike**, and **Operations**. Technical and operational stories still state a user or business outcome.

Implementation notes identify the relevant boundary and safety constraints; they are not permission to make unrelated architectural changes.

## Shared Definition of Done

For any implemented story:

1. Every numbered acceptance criterion has test or review evidence, including relevant invalid input, role, tenant, duplicate, retry and failure cases.
2. Backend behavior is covered by the existing Jest infrastructure and the applicable epic contract tests. Frontend changes pass TypeScript/build checks and the documented mode/locale smoke checks; new tooling is not required merely to author this backlog.
3. Shared auth, API, settings and layout changes are verified in both Shopify embedded and Standalone modes. Merchant-facing changes include Arabic/English translations, RTL/LTR, keyboard access, loading, empty and error states.
4. Tenant authority comes from validated authentication/integration context, never untrusted payload IDs. Credential administration requires owner/admin or separately authorized staff; viewers cannot mutate protected configuration.
5. Secrets never appear in logs, returned read DTOs, example requests, screenshots or backlog evidence. Customer data is minimized and retained only for the documented purpose.
6. Applicable migrations are additive, rehearsed with preflight/dry-run counts and idempotent backfill, and have a history-preserving rollback/disable procedure. Normal disconnect differs from authorized privacy redaction.
7. Local verification truth is distinguishable from external provider synchronization and message-delivery state. No accepted/queued operation is presented as already delivered or remotely applied.
8. Release evidence records commands, date, commit/build, outcomes, known limitations and operational recovery instructions. Existing Shopify characterization gates remain green when shared code changes.
9. Required source/contract documentation is updated and linked. A discrepancy between older prose and actual code is explicitly reconciled, not ignored.
10. External validation produces dated provider/merchant evidence. Unknown eligibility/authentication/status effects block live use; they are not accepted by assumption.

Use the [backend working guide](../akeed-backend/AGENTS.md) and [frontend working guide](../akeed-frontend/AGENTS.md) for existing commands/conventions. Backend `npm run lint` fixes files by default: use a non-fixing lint invocation when merely validating. The current Shopify adapter is GraphQL; preserve its characterized behavior rather than converting it because older prose mentions REST.

## Approved product defaults

- Custom websites and delivery businesses are the nearest Standalone segment; one generic API precedes bespoke integrations.
- One primary commerce source per organization. Source switching and multiple simultaneous sources are not MVP capabilities.
- Standalone pilots use an existing starter/manual plan with `billingStatus = not_required`; no new payment provider or invented quota plan.
- Manual creation uses session-authenticated `POST /api/orders`. Server integration uses API-key-authenticated `POST /api/v1/orders` with required `Idempotency-Key`.
- The canonical order covers trusted source identity, external ID/reference, phone/name, decimal amount, currency and payment/COD signals.
- Existing Shopify merchants remain on the Akeed sender unless explicitly migrated.
- Merchant-owned WhatsApp begins with assisted onboarding. Existing Business App number coexistence must be validated per merchant; it is never promised universally.
- EasyOrders is the first native adapter after the common boundaries/API. WooCommerce follows using core REST/application auth and signed webhooks, without a WordPress plugin.
- Shopify customer cancellation retains its current local-state/tag behavior; merchant no-reply cancellation retains its distinct remote cancellation semantics.

## Implementation safety defaults carried by the stories

These are explicit backlog design assumptions, not claims about current functionality:

- Owner/admin may manage setup, sources, keys and connections; viewers are read-only. Authorization is enforced in the backend.
- Native adapter pilots use fresh or unprovisioned organizations and source-selecting signup, rather than silently replacing an already active Standalone/Shopify source.
- Idempotency is source-scoped and survives credential rotation. Creation retries do not become implicit order edits.
- A verification's sender identity is pinned across initial/follow-up messages. No opted-in merchant credential failure silently switches the conversation to Akeed; explicit fallback selection applies to future verifications.
- Per-send ledger state records ambiguous provider acceptance. Do not promise exactly-once delivery or blindly retry an uncertain send.
- Automatic no_reply escalation is not authority for remote cancellation. Native status mappings require the owning validation spike and merchant-approved effects.
- Normal disconnect preserves order/verification/usage history and stops queued effects; privacy redaction remains a separate authorized workflow.
- WooCommerce store-URL access must prevent SSRF and unsafe redirects as part of its connection security.

## Evidence and baseline

### VERIFIED FROM CODE

The current repository inspection confirms reusable normalized orders, verification core, repositories, queues and dual auth, alongside globally bound Shopify/WhatsApp providers and incomplete Standalone runtime paths. Each story links the actual relevant files. Provider-name membership in a type or schema is not evidence of an implemented adapter.

Reference entry points:

- [Global provider bindings](../akeed-backend/src/app.module.ts)
- [Canonical order interface](../akeed-backend/src/shared/interfaces/order.interface.ts)
- [Database schema](../akeed-backend/src/infrastructure/database/schema.ts)
- [Standalone provisioning](../akeed-backend/src/infrastructure/database/repositories/standalone-organization-provisioning.repository.ts)
- [Global WhatsApp sender](../akeed-backend/src/infrastructure/spokes/meta/whatsapp.service.ts)
- [Dashboard feature](../akeed-frontend/src/features/dashboard)

### Historical test evidence — 2026-08-30

The case-study assessment recorded 242/243 backend tests passing across 26/27 passing suites, with a stale real-clock assertion in onboarding, and a passing frontend TypeScript check. These are **historical results**, not tests rerun while creating this backlog. US-01-01 must establish a fresh deterministic baseline during implementation.

### ASSUMPTION / REQUIRES VALIDATION

The roadmap is approved, but implementation, rollout economics and pilot outcomes remain proposed. Do not mark a story complete because its folder exists. Cohort authorization, support ownership and success measurements are set by the relevant pilot validation story before live onboarding.

### EXTERNAL PLATFORM DEPENDENCY

Primary references used by provider stories are listed below. All 15 reference links were reopened on 2026-08-31. Reachable documentation is an input for the owning spike, not validation of merchant account eligibility, live authenticity, delivery guarantees or status side effects.

- [Shopify — Webhooks](https://shopify.dev/docs/apps/build/webhooks)
- [Shopify — GraphQL orderCancel](https://shopify.dev/docs/api/admin-graphql/latest/mutations/orderCancel)
- [Meta — WhatsApp Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api)
- [Meta — Webhook payload reference](https://www.postman.com/meta/whatsapp-business-platform/folder/tduohwq/webhook-payload-reference)
- [Meta — Message templates](https://www.postman.com/meta/whatsapp-business-platform/folder/2l70wum/message-templates)
- [Meta Blueprint — Embedded Signup](https://www.facebookblueprint.com/student/path/253152-whatsapp-embedded-signup-course)
- [EasyOrders — Authentication](https://public-api-docs.easy-orders.net/docs/authentication)
- [EasyOrders — Authorized app link](https://public-api-docs.easy-orders.net/docs/create_authorized_app_link)
- [EasyOrders — Webhooks](https://public-api-docs.easy-orders.net/docs/webhooks)
- [EasyOrders — Get order by ID](https://public-api-docs.easy-orders.net/docs/get-order-by-id)
- [EasyOrders — Update order status](https://public-api-docs.easy-orders.net/docs/update-order-status)
- [EasyOrders — Rate limit](https://public-api-docs.easy-orders.net/docs/rate-limit)
- [WooCommerce — REST authentication](https://developer.woocommerce.com/docs/apis/rest-api/authentication)
- [WooCommerce — Webhooks](https://developer.woocommerce.com/docs/apis/rest-api/v3/webhooks/)
- [WooCommerce — REST API](https://developer.woocommerce.com/docs/apis/rest-api/)

Meta, EasyOrders and WooCommerce validation spikes explicitly record supported, unsupported and unknown behavior and block dependent live rollout when safety requirements remain unresolved.

## Deferred — do not turn into new epics in this delivery

- Microservices or additional messaging infrastructure products.
- New payment-provider selection/integration.
- Full self-service Meta Embedded Signup/Tech Provider rollout.
- Multiple active commerce sources or general source switching.
- Broad CSV automation, hosted checkout/order forms and browser-side JavaScript SDKs.
- A WooCommerce/WordPress plugin.
- Bespoke delivery-company adapters.
- Generic outbound merchant callbacks until a paid requirement is approved.
- Phone/reference search and other unrelated dashboard expansion.

## Backlog integrity checks

The authored package must contain exactly nine epic directories, 53 uniquely identified story files and ten README files. All priorities/types/statuses must be valid, each story must be indexed once, local links must resolve, and dependencies must be acyclic. Application repositories must remain unchanged by backlog creation.

The following are separate checks: documentation integrity now; software tests and live platform validation during implementation of the stories.

### Authoring validation — 2026-08-31

- Confirmed 9 epic folders, 53 story files and 10 README files: 63 Markdown files total.
- Confirmed 49 P0 and 4 P1 stories, unique IDs, valid ranks, complete required sections and at least four substantive acceptance criteria per story.
- Resolved all 591 local Markdown links and checked all 53 dependency nodes without cycles.
- Reopened all 15 unique external primary-reference URLs; provider behavior still requires the specified validation spikes.
- Both application Git repositories remained clean. No application tests, migrations or live merchant operations were executed as part of backlog authoring.
