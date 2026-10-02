# US-05-02 — Submit API orders to the existing ingestion command

- **Epic:** [E05 — Standalone Order Ingestion API](README.md)
- **Delivery rank:** 2 of 6
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Feature + core extraction
- **Status:** Done — E05 gate passed locally and the pilot is reported working as expected (product owner, 2026-10-02); see [evidence](../../US-05-02-API-ORDER-INGESTION-ENDPOINT-EVIDENCE.md)
- **Dependencies:** [US-05-01](US-05-01-integration-api-key-lifecycle.md)

## User story and value

As a custom website or delivery-system integrator, I want one authenticated order-submission endpoint, so that my orders are confirmed by Akeed exactly like orders the merchant enters or imports, without a platform-specific adapter.

**Business value:** Server integrations get the full verification pipeline with no second order-processing path to build or maintain.

## Scope

`POST /api/v1/orders`. The API **converts an external order into `CanonicalOrderInput` and submits it to the existing Standalone ingestion command.** Before any API code, the story moves the pre-accept steps that today live in the manual channel into the shared core, so the API and the manual form call one implementation.

**Out of scope:** Browser calls with embedded secrets, order updates, a batch endpoint (file import is E04.6), outbound callbacks, and external-ID replay/conflict (US-05-03).

## Part A — Core extraction (in `src/modules/order-ingestion/`, done first)

Today `OrdersService.createManualOrder` resolves the source, evaluates readiness and maps blockers to `MANUAL_ORDER_*` codes (`assertManualCreateReady`) before calling `acceptOne`. An API copy of that would be a second implementation of the rules. Instead:

1. **Resolve by integration.** Add `StandaloneSourceResolver.resolveForIntegration(orgId, integrationId, codes)`. It applies the same checks as `resolveWritable` — the org's single active source, Standalone, onboarding completed — and additionally requires that source to be the key's `integrationId`. No role check (the key was issued by an owner/admin).
2. **Shared readiness gate.** Add a readiness code map type (vocabulary per channel, like `StandaloneSourceCodeMap`) and one shared function that turns `SendReadinessBlocker[]` into the channel's exception with today's precedence: entitlement → auto-verify → credit (E04.5 code unchanged) → slot/plan limit → fail closed with `setupIncomplete`.
3. **One submit entry point.** Add `StandaloneOrderIngestionService.submitOne(principal, input, options)` composing resolve → `StandaloneSendReadinessService.evaluate(source, {required: 1})` → gate → `acceptOne`. The principal is either a session user (manual) or an integration principal (API); both end in the same `StandaloneIngestionContext`.
4. **Move manual onto it.** `createManualOrder` calls `submitOne` with `MANUAL_ORDER_*` maps. Response status, body and code stay **byte-identical**; `assertManualCreateReady` is deleted, not duplicated.

## Part B — The API channel (`src/modules/order-api/`)

Only after Part A is green. The API module holds the controller, the request DTO and `ApiOrderChannelAdapter`; nothing else.

## Acceptance criteria

1. **Fields.** Required: `externalOrderId`, `customerName`, `customerPhone`, `totalPrice` (decimal string), `currency`, `paymentMethod`. Optional: `orderNumber` (defaults to `externalOrderId` as the client wrote it) and the import extras `orderDate`, `city`, `address`, `notes`. Unknown fields are rejected.
2. **Identity from the key only.** Supplied `orgId`, `integrationId` or `platform` cannot retarget the request and never reach the command.
3. **Same command.** Valid orders go through `submitOne` → `acceptOne(ctx, input, {channel: 'api', idempotencyKey})` and return `{orderId, verificationId?, status: 'accepted', duplicate}`. Accepted is not delivered. The controller and `ApiOrderChannelAdapter` contain no persistence, envelope, fingerprint, dispatch, credit, readiness or eligibility code.
4. **Shared rules.** DTO decorators read `canonical-order.rules.ts`; phone goes through `PhoneService.standardize` (as manual does); `Idempotency-Key` is required and validated by `normalizeIdempotencyKey`; `externalOrderId` becomes `ref:<normalized>` through `normalizeOrderReference`. No limit, regex or currency list is re-declared.
5. **Channel is metadata.** `'api'` is appended to `STANDALONE_INGESTION_CHANNELS`, `IDEMPOTENCY_KEY_PREFIX` (`'api:'`) and the service's log-action map. The Standalone normalizer accepts it with no other change; nothing in `verification-core`, the normalizers or the eligibility strategies reads the channel.
6. **Safe errors.** Invalid fields (`API_VALIDATION_FAILED`), unready sources (`API_SOURCE_UNAVAILABLE`, `API_SETUP_INCOMPLETE`, `API_AUTO_VERIFY_DISABLED`, `API_ENTITLEMENT_REQUIRED`, `API_PLAN_LIMIT_REACHED`), credit denials (E04.5 codes unchanged) and `StandaloneIngestion*Error`s (`API_ORDER_ACCEPTANCE_FAILED`, `API_ORDER_DISPATCH_FAILED`, `API_ORDER_IDEMPOTENCY_CONFLICT`) are mapped by the adapter, with no partial business effects.
7. **Non-COD.** Known non-COD orders are accepted and visible but never sent, exactly as for manual orders; eligible orders use the same entitlement and automation.
8. **Manual unchanged.** The manual contract suite and `orders.service.spec.ts` pass without edits to expected bodies or codes.

## Implementation notes

- **Backend:** `order-api.controller.ts` (versioned, `IntegrationApiKeyGuard`), `dto/create-api-order.dto.ts`, `api-order.channel-adapter.ts` modeled on `ManualOrderChannelAdapter` (`toCanonicalOrderInput` + `rethrowAsHttp`). The body type and route pipe follow the global `ValidationPipe` rule so validation errors carry the coded body.
- **Frontend:** No order-submission UI.
- **Data:** No migration. Orders use the integration-scoped `(integration_id, external_order_id)` identity.
- **Operations:** HTTPS only; no keys in query strings.

## Test requirements

- Part A: unit tests for `resolveForIntegration` (wrong integration, inactive, non-Standalone, onboarding incomplete, second active source) and the shared gate's precedence; manual suites unchanged.
- Part B: schema validation, bad key, tenant spoofing, unready source, non-COD accepted-but-not-sent, each `API_*` code.
- A unit-level equivalence check: the same order through the manual, file-import and API adapters yields the same `CanonicalOrderInput` → envelope → fingerprint (the full lifecycle check is US-05-06).
- Architecture: extend `ingestion-boundary.spec.ts` / `release-gate-architecture.spec.ts` so `modules/order-api/` imports nothing from the README's forbidden list.
- Run the regression suites from [the prompts' shared rules](IMPLEMENTATION-PROMPTS.md#shared-rules) before and after.

## Migration and rollout

Restricted to pilot integrations; US-05-03 is required before any external release.

## Evidence and references

**VERIFIED FROM CODE (2026-10-02):** `acceptOne` does not resolve sources or evaluate readiness; the manual channel does both before calling it.

- [akeed-backend/src/modules/orders/orders.service.ts](../../../src/modules/orders/orders.service.ts) (`createManualOrder`, `assertManualCreateReady`)
- [akeed-backend/src/modules/orders/manual-order.channel-adapter.ts](../../../src/modules/orders/manual-order.channel-adapter.ts)
- [akeed-backend/src/modules/orders/dto/create-manual-order.dto.ts](../../../src/modules/orders/dto/create-manual-order.dto.ts)
- [akeed-backend/src/modules/order-ingestion/standalone-order-ingestion.service.ts](../../../src/modules/order-ingestion/standalone-order-ingestion.service.ts)
- [akeed-backend/src/modules/order-ingestion/standalone-source-resolver.ts](../../../src/modules/order-ingestion/standalone-source-resolver.ts)
- [akeed-backend/src/modules/order-ingestion/standalone-send-readiness.types.ts](../../../src/modules/order-ingestion/standalone-send-readiness.types.ts)
- [akeed-backend/src/shared/commerce/standalone-order-envelope.ts](../../../src/shared/commerce/standalone-order-envelope.ts)
- [akeed-backend/src/shared/commerce/canonical-order.rules.ts](../../../src/shared/commerce/canonical-order.rules.ts)
- [akeed-backend/src/modules/order-imports/file-import.channel-adapter.ts](../../../src/modules/order-imports/file-import.channel-adapter.ts)

**ASSUMPTION / REQUIRES VALIDATION:** The acceptance criteria describe approved proposed work, not completed functionality.

**EXTERNAL PLATFORM DEPENDENCY:** None.
