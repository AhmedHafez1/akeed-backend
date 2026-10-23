# EasyOrders support runbook

For Akeed support and on-call staff: what a disconnect does, how a merchant reconnects, what to check when orders stop arriving, and when to escalate. How the integration works is in [Integrations, Webhooks, And Automation](INTEGRATIONS_WEBHOOKS_AND_AUTOMATION.md#easyorders-connection); the switches are in [ENVIRONMENT.md](ENVIRONMENT.md#easyorders-connection).

Some EasyOrders behavior is not documented by EasyOrders. Section 3 lists it with the rule Akeed follows meanwhile. Do not fill those gaps from the public EasyOrders docs, and do not promise a merchant anything that depends on them.

## 1. What a disconnect does

An owner or admin disconnects from Settings → order source, or from the setup screen when the key was rejected. The API is `DELETE /api/easyorders/connection`. It works with `EASYORDERS_CONNECT_ENABLED=false` and for an organization that is not on the pilot list.

In one transaction, on Akeed's side only:

| What | After the disconnect |
| --- | --- |
| `integrations.is_active` | `false`. The row, its id and its settings stay. |
| API key, webhook URL token, both webhook secrets | Wiped from `easyorders_connections` (set to NULL). |
| Store id, currency, phone country | Kept. The store id is what a reconnect must match. |
| Verified-store claim (`store_verified_at`) | Cleared, so the store's one verified slot is free. |
| Open install links for the organization | Retired. A link opened before the disconnect cannot reconnect. |
| `disconnected_at`, `disconnected_by` | Set. This is the audit record, with the `easyorders-disconnect` log line. |
| Orders, verifications, events, usage, outcome rows | Untouched. Nothing is deleted. |

What stops, and where it is enforced:

| Effect | Result |
| --- | --- |
| A new webhook on the old address | `401`, nothing stored. The token no longer resolves to a connection. |
| An event already queued, or waiting for dispatch | Skipped as `integration_inactive`. No order is created. |
| A first message, reminder or no-reply step already scheduled | Not sent (`integration_inactive`). |
| An order-status update waiting to retry | Closed as failed with `integration_inactive` at the disconnect. No request is made. |
| A customer who replies afterwards | The reply is recorded in Akeed. Nothing is written to EasyOrders. |

One thing cannot be stopped: a request to EasyOrders that was already on the wire at the instant of the disconnect.

A disconnect is not a privacy redaction. Orders, customer phones and verification history stay; deleting customer data is a separate authorized workflow.

## 2. Removal at EasyOrders

After the local disconnect, Akeed asks EasyOrders to delete its two webhooks (`DELETE webhooks/delete-by-url` for the orders address and the status address), with the key it just wiped. It sends `Api-Key` and, after a `401` or `403`, `Authorization: Bearer`. Each address is tried up to three times while EasyOrders answers 2xx, because a retried install registers the same address twice. `404` counts as nothing left.

The call never blocks or undoes the disconnect. A failure is logged as `easyorders-disconnect-remove-webhooks`. The outcome is stored on the row and returned in the status as `provider_cleanup`:

| `provider_cleanup` | What the merchant is told on the disconnected screen |
| --- | --- |
| `removed` | Open **Settings → Public API** in EasyOrders and delete the API key named **Akeed**. Nothing else. |
| `manual` (a call failed, or EasyOrders could not be reached) | The same, and under **Webhooks** delete every webhook named **Akeed**. Until they do, EasyOrders keeps calling the old address; every call answers `401` and stores nothing, and those calls cannot be counted per merchant. |

EasyOrders has no call that deletes an API key. Deleting it in the EasyOrders dashboard is the only way, and Akeed no longer holds the key, so it cannot use it.

Webhooks and keys left by an install the seller accepted but that never reached Akeed are not removed either: Akeed never received a key for them.

## 3. What EasyOrders does not document

None of these is assumed in code or in merchant-facing copy.

| Not documented | What Akeed does meanwhile |
| --- | --- |
| The response to a wrong, missing or revoked key, and how fast revocation takes effect | `401` and `403` are treated as a permanent rejection (`credentials_rejected`). The app says "the last answer EasyOrders gave, not a live check". |
| Whether EasyOrders keeps calling a URL that answers `401`, or disables it | Nothing is promised. The merchant is told to delete the webhooks. |
| The auth header of `delete-by-url` | Called at disconnect with `Api-Key`, then `Bearer`. Any failure leaves the manual steps (`provider_cleanup = 'manual'`). |
| What EasyOrders does on an app uninstall | Not relied on. |
| Whether a webhook secret can be regenerated without recreating the webhook | A reconnect creates new webhooks with new secrets, and Akeed learns both again. |
| Whether the install callback carries the webhook secrets | Assumed not. Akeed learns each secret from the first delivery whose order it can read back with the store's key. |
| What the rate limit applies to (key, store, app or IP), and its window | Akeed spends at most 30 requests a minute per integration and treats the limit as shared by everything that touches the store. |

Because the revoked-key response is not documented, **a key removed at EasyOrders may go unnoticed** while outcome sync is off: nothing on the webhook path uses the key once the store is verified. Credential health is the last observed answer.

## 4. Reconnect

Only from the disconnected state, and only to the same store. There is one path: the same install link and callback as a first connect (`POST /api/easyorders/install`, then the seller accepts in EasyOrders).

- Needs `EASYORDERS_CONNECT_ENABLED=true` and, when `EASYORDERS_PILOT_ORG_IDS` is not empty, the organization on it. A disconnect needs neither.
- The callback's `store_id` must equal the one stored. Otherwise `409 EASYORDERS_RECONNECT_STORE_MISMATCH`, and nothing changes.
- If another organization has verified that store since, `409 EASYORDERS_STORE_UNAVAILABLE`.
- On success the same integration row becomes active again, with a new key and a new webhook address. Both webhook secrets are empty and are learned from the first verified deliveries; orders are accepted in the meantime and each is read back from EasyOrders. Orders placed while disconnected are not imported later.
- The store claim is unverified again and is re-verified on the first order read with the new key.
- A reconnect leaves a second set of Akeed webhooks at EasyOrders if the old ones were not deleted. The old ones answer `401`. Guidance: keep exactly one orders webhook and one order-status webhook for Akeed, and delete the rest.

Refusals a merchant can hit, and what to tell them:

| Code | Meaning | Action |
| --- | --- | --- |
| `EASYORDERS_RECONNECT_STORE_MISMATCH` | They signed in to a different EasyOrders store | Reconnect while signed in to the original store. A different store needs staff (see section 6). |
| `EASYORDERS_STORE_UNAVAILABLE` | Another Akeed account has verified this store | Escalate. Do not move a store between accounts by hand. |
| `EASYORDERS_SOURCE_EXISTS` | The source is not in the disconnected state (still connected, or switched off by staff) | A connected store must be disconnected first. A staff-deactivated one is not the merchant's to reconnect. |
| `EASYORDERS_KEY_REJECTED`, `EASYORDERS_PROVIDER_UNAVAILABLE` | EasyOrders rejected the new key, or could not be reached | Retry. Each attempt leaves a key and webhooks at EasyOrders to delete. |
| `EASYORDERS_PILOT_REQUIRED`, `EASYORDERS_CONNECT_UNAVAILABLE` | Off the pilot list, or the feature is off | Staff decision. The history stays readable meanwhile. |

A revoked key (`credentials_rejected`) is recovered the same way: disconnect, then reconnect. There is no in-place key rotation.

A disconnect made by mistake is undone by reconnecting the same store. The integration id and history are unchanged, and nothing is pasted.

## 5. Deliveries refused after the merchant recreated the webhooks

A merchant who deletes and recreates the Akeed webhooks in EasyOrders gets new secrets, so every delivery is refused (`secret_mismatch`) and `rejected_deliveries` grows. Settings → order source shows the count and opens "Fix the webhook secrets":

- **Reset and learn again** (`DELETE /api/easyorders/connection/webhook-secrets`, owner or admin) forgets both secrets and the counter, and the next verified delivery is learned from.
- Pasting both secrets by hand (`PUT` on the same path) still works.

## 6. Support escalation

1. **Merchant → Akeed support.** For anything in Akeed: the connection state, refused orders, a reconnect that fails.
2. **Akeed support → staff checks.** Read-only, by organization:
   - `GET /api/settings/source-health` as the merchant sees it: credentials, last accepted event, processing failures, backlog, store-update failures, refused deliveries.
   - `easyorders_connections`: `health`, `disconnected_at`, `disconnected_by`, `provider_cleanup`, `rejected_deliveries`, `last_rejected_at`, `store_verified_at`. Never read or copy the `*_encrypted` columns.
   - `webhook_events` for the integration: `status`, `last_error` (for example `integration_inactive`, `store_mismatch`, `missing_currency`).
   - `commerce_outcome_syncs` for the integration: `state`, `error_code`, `requires_assistance`.
   - Backend log: `"action":"easyorders-disconnect"`, `"easyorders-install-callback"`, `"easyorders-webhook-accept"`.
3. **Akeed staff → EasyOrders.** Only for behavior on the EasyOrders side: a key or webhook that cannot be deleted, deliveries that never arrive, an inactive-store answer the merchant disputes. Contact `info@easy-orders.net`. Send the store id and the times; never send an API key, a webhook secret or a webhook URL.

Do not promise the merchant that a reconnect is instant or that missed orders will be recovered. Neither is true.

**Automatic cancellation.** A store that switched on **Cancel unanswered orders automatically** has orders canceled in the store when they reach no reply and every message was delivered. Staff checks: `verification_auto_cancellations` for the verification (`status`, `reason`, `attempts`, `late_reply_at`), its `verification_auto_cancellation_events`, and the `commerce_outcome_syncs` row for `automatic_no_reply_cancellation`. A row `skipped` with `status_not_writable` means the merchant had already moved the order on in the store.

Requests that need staff and have no self-service path:

- Connecting a different EasyOrders store to an account that already had one.
- Switching an account to another order source.
- Deleting customer data.

## 7. Turning the feature off

Disconnect and reconnect have no switch of their own. Turning `EASYORDERS_CONNECT_ENABLED` off stops new connects and reconnects and leaves disconnect, status and history working.
