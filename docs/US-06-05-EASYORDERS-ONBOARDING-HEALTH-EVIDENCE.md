# US-06-05 EasyOrders setup, health and disconnect evidence

**Validated:** 2026-10-03
**Revision:** backend `ab2cd6c`, frontend `98e60ba`, both on `develop`
**Decision:** implemented and shipped behind the existing switches. It adds no switch of its own: connect and reconnect need `EASYORDERS_CONNECT_ENABLED` and the pilot list, disconnect and the health read need neither. Live onboarding stays blocked on the US-06-01 go-live verification, as for US-06-02 to US-06-04.

EasyOrders behavior is taken only from the [US-06-01 contract record](Epics/06-easyorders-integration/evidence/US-06-01-contract-record.md), sections 1, 2, 4, 6 and 7. No request was sent to EasyOrders, Meta or Shopify while building or testing this story: the provider is a fake `fetch` in every test.

Operations: [disconnect, removal and support runbook](Epics/06-easyorders-integration/evidence/US-06-05-disconnect-and-support-runbook.md).

## What the code had, against the story's evidence note

The story said onboarding resolution was Shopify-specific. Most of it was not: `resolveCurrentIntegration` only pins a Shopify session to its shop and otherwise finds the organization's one active source, whatever its platform. The test-message path (`onboarding-test.service.ts`) was already neutral too, so it needed no change. The story file now says so.

What was actually tied to a platform, and is changed:

- The store-name prefill skipped every platform except Shopify and Standalone.
- Only a Standalone source had a setup block, so `POST /api/onboarding/complete` answered `source_invalid` for anything else. An EasyOrders organization could not finish onboarding, and every real order would have been skipped as `onboarding_incomplete`.
- A source that is not active answered `404` on state and settings, with no way to read its history or reconnect it.
- Reconnect was refused by construction: any integration row, active or not, blocked a connect.

## Decisions

Product owner, 2026-10-03:

| Topic | Decision |
| --- | --- |
| Provider cleanup at disconnect | Manual steps only. No `delete-by-url` call: its auth header is UNKNOWN and Akeed stores only a hash of the URL token. This differs from the cleanup bullet in section 6 of the contract record; the record was not edited and the runbook records the difference. Owed to go-live step 12. |
| Finishing setup | A checklist on the EasyOrders screen, then the existing free test message, then completion. |
| A revoked key | Recovered by disconnect, then reconnect. Reconnect is offered only from the disconnected state. |

Taken while building, for review:

| Topic | Decision |
| --- | --- |
| How onboarding learns about a connection | One registry, `SOURCE_SETUP_CONTRIBUTORS`, read by `SourceSetupService`. The EasyOrders contributor lives in the spoke. Nothing in the onboarding module names a provider; the HTTP spec uses a contributor for a made-up connection to prove it. |
| Shopify and Standalone responses | Unchanged. `sourceSetup` is a key that is absent, not null, for a source without a contributor. `standaloneSetup` and every existing code stay. |
| What a disconnect wipes | The API key, the URL token hash and hint, both webhook secrets and the verified-store claim. It keeps the store id, currency and phone country. A CHECK constraint enforces "credentials if and only if connected". |
| The verified-store slot | Released at disconnect and not restored at reconnect: the new key has proven nothing (contract record section 2). It is re-verified on the first order read with the new key. |
| `onboarding_status` at disconnect | Left as it is. Shopify resets it because an uninstall purges; here history must stay reachable, and a pending account would be sent to setup from every route. |
| "Revoked" | The existing health value `credentials_rejected`, shown as its own view. Not a new state. `disconnected` is a new state. |
| Reconnect target | The same integration row and the same `easyorders_connections` row, updated in place, so orders and history stay attached. |
| An inactive EasyOrders source with no recorded disconnect | Not reconnectable by the merchant and not readable as "disconnected". It was switched off by something else. |
| Waiting store updates at disconnect | Closed as `integration_inactive` at once (best effort, after the transaction), so none waits forever for a job that may be lost. |
| Akeed sender status | An optional method on `MessagingPort`, answered from configuration: `configured`, `not_configured`, or `unknown` for an adapter that cannot tell. No provider call, and no claim about delivery. |
| Health | Separate signals with no overall verdict. `lastAcceptedAt: null` is "no events yet", never a fault. Read from `GET /api/settings/source-health`, by any member, including after a disconnect. |
| Disconnect gating | Not gated by the connect switch or the pilot list: turning the feature off must not trap a merchant in a connection. |

## Implemented behavior

- **Data.** Migration `0050_easyorders_disconnect.sql`, additive and re-runnable, with its `_journal.json` entry and the schema change. `disconnected_at`, `disconnected_by`; `api_key_encrypted`, `webhook_token_hash` and `webhook_token_hint` become nullable; `easyorders_connections_credentials_state_check` ties them together. No existing row is rewritten.
  - Rollback: reconnect or delete rows with `disconnected_at` set, drop the check, restore `NOT NULL` on the three columns, drop the two columns. Orders and verifications are unaffected.
- **Disconnect.** `DELETE /api/easyorders/connection` (owner or admin). One transaction in `withSerializableRetry`: retire open install contexts, lock the organization and the connection, set `integrations.is_active = false`, wipe the credentials. A second call is a no-op. Nothing is purged and nothing is removed at EasyOrders.
- **Queued effects.** They rely on the `is_active` guards that already existed (webhook acceptance, `WebhookQueueProcessor.resolveSource`, the automation worker, the dispatch claim, `CommerceOutcomeRegistryService`). New code only where the key can now be null: the outcome adapter answers `integration_inactive` for a disconnected connection, the normalizer skips, and the settings and secrets writes refuse a disconnected row.
- **Reconnect.** Through `POST /api/easyorders/install` and the callback. Allowed only when the organization's one source is its own disconnected EasyOrders source. A different store is `409 EASYORDERS_RECONNECT_STORE_MISMATCH`; a store another organization has verified is `409 EASYORDERS_STORE_UNAVAILABLE`. New key, new URL token, no secrets, counters reset.
- **Status.** `GET /api/easyorders/connection` gains state `disconnected` and `connection.disconnectedAt`; `webhookUrlHint` is null once disconnected. A reconnect under way shows as `pending`, `failed` or `expired` with the connection still described. Readable with the switch off.
- **Onboarding.** `GET /api/onboarding/state` and `GET /api/settings` carry `sourceSetup` for a source with a contributor: connection state, store, order defaults, sender status and the blocked reasons (`order_defaults_missing`, `webhook_secrets_missing`, `credentials_rejected`, `source_disconnected`, after the common ones). `POST /api/onboarding/complete` honors them. Both reads keep working for a disconnected source; every write still answers `404 ONBOARDING_SOURCE_INACTIVE`.
- **Health.** `GET /api/settings/source-health`: credentials (last observed), last accepted event and count, processing failures, backlog, store-update failures and pending, refused deliveries, and each outcome action with whether the store takes it now. Two new aggregate queries, both scoped by organization and integration.
- **Frontend.**
  - Setup: the connected screen ends in a checklist (store, country and currency, webhook secrets, Akeed sender), a summary of the automation that will run, and the number for the free test. Then the shared test step and completion. The stepper names the middle step by source.
  - Revoked and disconnected views, the removal steps for EasyOrders, and a reconnect that says it must be the same store.
  - Settings: the order-source tab resolves a skin by platform. EasyOrders gets a connection panel (secrets, disconnect with a confirmation, reconnect) and the health card. A disconnected source makes Settings read-only with its own notice.
  - A finished account whose source needs something lands on the order-source tab instead of the dashboard, which is also where EasyOrders' redirect arrives after a reconnect.
  - Arabic and English for every state. No key, token, secret or install link is rendered.

Shopify code is unchanged. Shared changes: the optional `getSenderStatus` on the messaging port, the optional `SourceSetupService` on the two onboarding services, the removal of the store-name allow-list (Shopify still asks its platform port), and the two repository aggregates.

## Acceptance criteria

| AC | Evidence |
| --- | --- |
| 1. Onboarding identifies the store, currency and phone-country defaults, automation settings and Akeed sender status | Unit: `source-setup.spec.ts` "identifies the store, the order defaults, automation and the Akeed sender", sender status tests. Frontend: `EasyOrdersConnectPage.test.tsx` "setup checklist" (Arabic and English). The defaults are merchant-chosen, not provider-verified: the contract record (section 4) says no endpoint exposes them. |
| 2. Health separates credentials, last accepted event, processing failure and store-update failure; silence is not a fault | Unit: `source-setup.spec.ts` "health" (four tests). Contract: ingestion "source health" (four tests), outcome-sync "store-update health" (four tests). Frontend: `SourceHealthCard.test.tsx` "describes a store with no events without flagging it". |
| 3. Owner or admin disconnect blocks new and queued effects, follows the provider procedure, keeps history | Contract: connection "disconnect and reconnect" (wipe, idempotence, viewer); ingestion "a disconnected source" (old address `401`, queued event, outage recovery, reminder, history kept); outcome-sync "a disconnected source" (queued retry, reply afterwards, adapter guard). The provider procedure is the manual removal in the runbook; see the decision above. |
| 4. Reconnect only to the same store and source; never another merchant's store or over a different source | Contract: "reconnects the same store in place", "a refused reconnect leaves the source disconnected and unchanged", "refuses a reconnect when another organization has verified the store since", "another tenant cannot disconnect this connection or reconnect into its store", "refuses an inactive source of another platform", the existing active Standalone and Shopify refusals. |
| 5. Arabic, English and RTL: success, pending, revoked, disconnected and actionable errors, without secrets | Frontend: `EasyOrdersConnectPage.test.tsx` (revoked, disconnected, reconnect error in both languages), `EasyOrdersSourcePanel.test.tsx`, `SourceHealthCard.test.tsx`, `sourceSkins.test.ts` (key parity; no promise of instant recovery). Contract: "never puts a key, token or webhook secret in a response, a log line or a stored column" now includes the disconnect and reconnect responses. |

## Test requirements

| Case | Where |
| --- | --- |
| Expired key | Contract: "a key EasyOrders rejects is recovered by disconnect then reconnect, on the same source". Unit: `easyorders-setup.contributor.spec.ts`, `source-setup.spec.ts` "blocks completion for a key the provider rejected". Frontend: revoked view tests. |
| Missing webhook | Unit: contributor "blocks setup while a webhook secret is missing". Contract: reconnect clears both secrets; ingestion "after a reconnect the new address feeds the same source" (refused until the secrets are pasted). Frontend: checklist and health card. |
| Queue backlog | Contract: ingestion "reports events waiting while the queue is down and none after recovery". |
| Unsupported action | Unit: `source-setup.spec.ts` "shows every outcome the store cannot take as unsupported". Contract: outcome-sync "an unsupported outcome is not counted as a failed store update". Frontend: health card capabilities. |
| Connection retry | Contract: "a refused reconnect ... and the next attempt connects", "a second disconnect changes nothing", "two reconnect callbacks at once bring the source back once". |
| Viewer | Contract: "refuses a viewer's disconnect and reconnect". Unit: `source-setup.spec.ts` "lets a viewer read setup and health and refuses completion", auth service spec. Frontend: viewer tests on the page, the panel and the checklist. |
| Cross-tenant | Contract: connection "another tenant cannot disconnect ...", ingestion "never reports another tenant's events", outcome-sync "closes only its own waiting rows", "never reports another tenant's store updates". |
| Same-store reconnect | Contract: "reconnects the same store in place" (same integration id, old address dead, new one live, store re-verified on the first order). |
| Historical reporting after disconnect | Contract: ingestion "keeps orders, verifications and events after a disconnect, and health still reports them"; outcome-sync "still reports after a disconnect". Unit: `source-setup.spec.ts` "after a disconnect" (five tests). |

## Validation results (as run, 2026-10-03)

Backend (`akeed-backend`):

| Command | Result |
| --- | --- |
| `npx tsc --noEmit -p tsconfig.json` | PASS, no errors. |
| `npx tsc -p tsconfig.build.json --outDir .tmp/us-06-05-build` | PASS. Used instead of `npm run build`, which deletes `dist` under a running dev server. `nest build` itself was not run. |
| `npx eslint <touched files>` | PASS, no errors or warnings. |
| `npx prettier --check --end-of-line crlf <touched files>` | PASS. |
| `npm run log:check` | PASS, 0 violations. |
| `npx jest` | PASS, 181 suites, 4647 tests. |
| `npm run test:core:platform-neutral` | PASS, 173 tests. |
| `scripts/test-easyorders-connection-contract.ps1` | PASS, 58 tests (applies 0047, 0048 and 0050 twice). |
| `scripts/test-easyorders-ingestion-contract.ps1` | PASS, 58 tests. |
| `scripts/test-easyorders-outcome-sync-contract.ps1` | PASS, 33 tests. |
| `scripts/test-order-imports-contract.ps1` | PASS, 60 tests (0050 added to its migration list). |
| `scripts/test-source-identity-contract.ps1` | PASS, 1 test. |
| `scripts/test-shopify-contract.ps1` | PASS, 11 tests. |
| `scripts/test-standalone-provisioning-contract.ps1` | PASS, 10 tests. |

The existing Shopify specs, `provider-neutral-settings.spec.ts`, `onboarding.service.spec.ts`, `onboarding-state.service.spec.ts` and `onboarding-setup.spec.ts` were not edited. One existing contract test was renamed, with the same assertion: "refuses an inactive source of another platform: there is no source switching".

Frontend (`akeed-frontend`):

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | PASS, no errors. |
| `npm run lint` | PASS, 0 errors, 4 warnings that were already there. |
| `npx prettier --check --end-of-line crlf <touched files>` | PASS. |
| `npm run test` | PASS, 95 files, 1012 tests. `useStandaloneOnboardingFlow.test.tsx` and `TestStep.test.tsx` pass unedited after the hook extraction. |
| `NEXT_DIST_DIR=.next-us0605 npx next build` | PASS. The edit it made to `tsconfig.json` was reverted and the output directory removed. |

Not run:

- The E02 to E05 release gates (`npm run test:gate:*`).
- The remaining contract suites: manual order ingestion, order import release gate, order API, entitlements, platform-boundary migration, integration keys, verification overview, Paymob checkout and the E04.5 credit and billing suites.
- Any browser check. Every changed screen is behind login; Arabic/RTL, English, light and dark, and keyboard use of the disconnect dialog still need a person's eyes.
- Anything against EasyOrders, Meta, a shared database or a deployed environment. Migration 0050 was applied by these runs only to disposable PostgreSQL containers. It also runs at boot, so a local API in watch mode will have applied it to its own development database when it restarted.

## Open items and known limits

1. **Credential health is the last observed answer.** The revoked-key response is UNKNOWN (contract record section 2), nothing on the webhook path uses the key once the store is verified, and outcome sync ships off. A key deleted in EasyOrders may go unnoticed. The copy says "not a live check". No probe button was added: the fail-closed probe may refuse an active store (US-06-02 open item 1).
2. **Old webhooks keep answering `401`** after a disconnect and after a reconnect, until the merchant deletes them. They cannot be counted, and whether EasyOrders disables them is UNKNOWN.
3. **Automatic webhook removal is not built** (decision above; go-live step 12).
4. **A request already on the wire at the disconnect cannot be recalled.**
5. **Reconnect needs the connect switch on and the organization on the pilot list.** Otherwise the merchant sees `EASYORDERS_CONNECT_UNAVAILABLE` or `EASYORDERS_PILOT_REQUIRED`. History and health stay readable.
6. **A different store cannot be reconnected**, including after a store whose claim was never verified. That is a support path.
7. **After a reconnect, orders are refused until the two new secrets are pasted**, and `onboarding_status` stays `completed`. The prompts are the Settings notice, the health card and the route guard's redirect. Orders placed in that window are not imported.
8. **The API keys tab is still shown for an EasyOrders source.** The backend refuses it with `API_KEY_SOURCE_UNSUPPORTED`. Hiding the tab touched the tab component and its tests, so it was left out.
9. **`POST /api/onboarding/setup` completes onboarding without the setup check**, for any source. It is the embedded (Shopify) path; the non-embedded flows use `/complete`. Existing behavior, not changed.
10. **The test message shows `integrations.shipping_currency`**, not the EasyOrders store currency. Existing behavior of the test preview, not changed.
11. **`idx_webhook_events_integration_status_received`** (migration 0022) is not declared in `schema.ts`. The health query uses it. Existing drift, not fixed here.
12. **Sender status says only that this deployment holds the sender's credentials.** A check against Meta (quality, template approval) is not built.
13. Shared dashboard copy ("Canceled in Shopify", "Complete Standalone setup") is unchanged (US-06-03 open item 10).

## Operational notes

- **Deploy:** migration 0050 runs at boot. No new environment variable.
- **A merchant cannot finish setup:** read `GET /api/onboarding/state` → `sourceSetup.blockedReasons`.
- **A merchant reports no orders:** read `GET /api/settings/source-health`. "No events yet" with secrets set usually means the store has had no order, or its webhooks were deleted or duplicated in EasyOrders. Refused deliveries point at the secrets.
- **Logs:** `easyorders-disconnect` (`outcome`, `storeWasVerified`, `closedPendingSyncs`), `easyorders-disconnect-close-syncs` (failure only), `easyorders-install-callback` (`reconnected`).
- **Everything else:** the [runbook](Epics/06-easyorders-integration/evidence/US-06-05-disconnect-and-support-runbook.md).

## Changed after this story (2026-10-08)

Two decisions above were replaced by the product owner. This file is left as written; the current behavior is in the [runbook](Epics/06-easyorders-integration/evidence/US-06-05-disconnect-and-support-runbook.md) and in `INTEGRATIONS_WEBHOOKS_AND_AUTOMATION.md`.

- **Provider cleanup at disconnect** is no longer manual only: Akeed deletes its two webhooks with `delete-by-url` and records `provider_cleanup` (migration 0062). Open item 3 is closed, except that the call is still unverified against a live store (go-live step 12). The API key stays manual.
- **Webhook secrets are learned**, not pasted. `webhook_secrets_missing` is no longer a blocked reason, and open item 7 no longer applies: after a reconnect orders are accepted and read back until the new secrets are learned.
