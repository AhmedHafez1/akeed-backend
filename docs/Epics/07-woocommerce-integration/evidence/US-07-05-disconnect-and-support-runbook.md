# US-07-05 — WooCommerce disconnect, webhook recovery and support runbook

- **Written:** 2026-10-05
- **For:** Akeed support and on-call staff, and whoever runs the US-07-06 release gate.
- **Source of truth for WooCommerce behavior:** the [US-07-01 contract record](US-07-01-contract-record.md) and its amendments. Where this runbook says UNKNOWN, the record does too. Do not fill those gaps from memory of WooCommerce or from its source code.

Nothing here has been observed on a real store yet. The US-07-06 live run owns that; until then every statement about what a store does is the documented behavior or the record's worst-case rule.

## 1. What a disconnect does

An owner or admin disconnects from Settings → order source, or from the setup screen when the store rejected Akeed's key. The API is `DELETE /api/woocommerce/connection`. It works with `WOOCOMMERCE_CONNECT_ENABLED=false` and for an organization that is no longer on the pilot list.

It runs in this order (product owner, 2026-10-05; see the amendment in the contract record):

1. **One transaction, on Akeed's side.** The source stops and its credentials are wiped.
2. **Then the store is asked to delete Akeed's two webhooks**, with the keys step 1 read, held in memory for that request only. Best effort, 15 seconds at most.
3. **Then every store update still waiting is closed.**

| What | After the disconnect |
| --- | --- |
| `integrations.is_active` | `false`. The row, its id and its settings stay. |
| Consumer key, consumer secret, webhook secret | Wiped from `woocommerce_connections` (set to NULL). |
| Delivery URL token hash, the two webhook ids, the last webhook states | Wiped. |
| Canonical store URL | Kept. It is what a reconnect must match. |
| Verified-store slot (`store_verified_at`) | Cleared, so another organization can connect that store. |
| Open install links for the organization | Retired. A link opened before the disconnect cannot reconnect. |
| `disconnected_at`, `disconnected_by` | Set. This is the audit record, with the `woocommerce-disconnect` log line. |
| Orders, verifications, events, usage, outcome rows | Untouched. Nothing is deleted. |
| `onboarding_status` | Left as it is. |

What stops, and where it is enforced:

| Effect | Result |
| --- | --- |
| A new delivery on the old address | `401`, nothing stored. The token no longer resolves to a connection. |
| An event already queued, or waiting for dispatch | Skipped as `integration_inactive`. No order is created. |
| A first message, reminder or no-reply step already scheduled | Not sent (`integration_inactive`). |
| A store update waiting to retry | Closed as failed with `integration_inactive` at the disconnect. No request is made. |
| A customer who replies afterwards | The reply is recorded in Akeed. Nothing is written to the store. |

One thing cannot be stopped: a request to the store that was already on the wire at the instant of the disconnect.

A second disconnect changes nothing and calls no store. It does retire a reconnect link that was opened since.

## 2. What a disconnect does not do

### The API key stays in the store

Akeed cannot revoke its own key. The REST reference lists no resource for API keys (contract record 7.4), and whether any call can remove one is UNKNOWN (7.5), so Akeed makes none. The merchant does it. The app shows these steps on the disconnected screen, in the disconnect dialog and in Settings:

1. In WordPress, open **WooCommerce → Settings → Advanced → REST API**.
2. Find the key named **Akeed** and choose **Revoke**.

Until they do, the store keeps the key valid. Akeed no longer holds it, so Akeed cannot use it.

### The webhooks, when the store did not take the deletion

The answer to the disconnect says what happened: `webhookCleanup` is `removed`, `failed` or `not_attempted`. The screen shows it, and the log line `woocommerce-disconnect` carries it. `failed` also writes `woocommerce-disconnect-webhook-cleanup` with the reason (a code, never store text).

`failed` happens when the store did not answer in time, refused the call, or had already rejected the key. It does not undo the disconnect. The merchant then deletes them by hand:

3. Under **WooCommerce → Settings → Advanced → Webhooks**, delete any webhook whose name starts with **Akeed** (`Akeed order created`, `Akeed order updated`).

Until they do, the store keeps calling the old address. Every call answers `401` and stores nothing, and by the documented rule the store disables each webhook after 5 failures in a row (contract record 3.11; the real number is the store's own, 3.14). These calls cannot be counted per merchant, because the token no longer resolves to a connection.

If the API process dies between step 1 and step 2, the source is disconnected, no deletion was tried and nothing reports it. The same end state applies: the webhooks answer `401` and disable themselves. A reconnect removes them (section 4).

### It is not a privacy redaction

Orders, customer phones and verification history stay. Deleting customer data is a separate authorized workflow.

## 3. A disabled webhook: recovery checklist

WooCommerce disables a webhook after consecutive failed deliveries. Akeed does not poll. It reads the state of both webhooks from the store only when:

- the health card is opened (`GET /api/settings/source-health`),
- an owner or admin presses **Check connection** (`POST /api/woocommerce/connection/check`),
- a re-enable runs.

What it read is stored on the connection row (`order_created_webhook_state`, `order_updated_webhook_state`, `webhooks_checked_at`) and is what setup and the connection panel show in between.

When a merchant reports that orders stopped arriving:

1. Ask them to open Settings → order source. Opening it reads the store.
2. Read the two webhook rows in the health card, or `woocommerce_connections` for the organization.

| State | Meaning | Action |
| --- | --- | --- |
| `active` | The store says it delivers | Look at "Events refused before processing" and the event rows (section 6). |
| `disabled` | The store stopped it after failed deliveries | Find the cause first (below), then **Re-enable order notifications**. |
| `paused` | The merchant paused it in WooCommerce | They activate it there. Akeed never overrides a pause. |
| `missing` | It was deleted in the store | Disconnect, then reconnect the same store. |
| `unknown` | The store did not answer, or refused the key | Run **Check connection** for the code. |

3. **Before re-enabling, find why it was disabled.** A webhook re-enabled into the same failure is disabled again, and whether re-enabling resets the store's failure count is UNKNOWN (3.17): assume one more failure disables it.

| Cause | How to tell | Fix |
| --- | --- | --- |
| `WOOCOMMERCE_INGESTION_ENABLED` was off when orders arrived | Deployment configuration; every order delivery answered `404` | Turn ingestion on first. Re-enable is refused while it is off (`503 WOOCOMMERCE_WEBHOOK_ENABLE_UNAVAILABLE`). |
| The webhook was edited in WooCommerce (secret, URL) | `rejected_deliveries` is above zero | Disconnect and reconnect. Re-enabling cannot fix a wrong secret. |
| The store reports another address than the one connected | The check answers `WOOCOMMERCE_STORE_URL_MISMATCH`; `rejected_deliveries` rises | A different address cannot be connected to this account. Escalate (section 5). |
| Akeed answered `5xx` | `woocommerce-webhook-not-persisted` in the API log at that time | An Akeed incident. Fix it, then re-enable. |

4. Re-enable: the button in Settings or the setup screen, or `POST /api/woocommerce/connection/webhooks/enable` as an owner or admin. Akeed reads both webhooks, sets each `disabled` one to `active`, and reads them again. It reports success only for a state the store confirmed.

| Answer | Meaning |
| --- | --- |
| `200` | Every webhook that was disabled reads `active`. |
| `409 WOOCOMMERCE_WEBHOOK_MISSING` | One was deleted in the store. Nothing was changed. Reconnect. |
| `503 WOOCOMMERCE_WEBHOOK_ENABLE_FAILED` | The store did not take the change, or still shows `disabled`. A host that refuses `PUT` lands here (contract record 8.4): outside the support boundary. |
| `503 WOOCOMMERCE_WEBHOOK_ENABLE_UNAVAILABLE` | Ingestion is off on this deployment. A staff decision, not something the merchant can fix. |
| `422 WOOCOMMERCE_CREDENTIALS_REJECTED`, `WOOCOMMERCE_PERMISSION_DENIED` | The store refuses the key. Disconnect and reconnect. |

5. **Tell the merchant plainly: orders placed while the webhook was disabled were not sent to Akeed and are not imported** (product decision 7). There is no backfill and no polling. They confirm those orders by hand.

## 4. Reconnect

Only from the disconnected state, only for the organization's own WooCommerce source, and only to the same canonical store URL. There is one path: the same start and callback as a first connect (`POST /api/woocommerce/install`, then the merchant approves in the store). The app sends the stored address; there is no field to type another.

- Needs `WOOCOMMERCE_CONNECT_ENABLED=true` and the organization on `WOOCOMMERCE_PILOT_ORG_IDS`. A disconnect needs neither.
- A different store, the same host under another path, or `www.` against the bare domain is refused at the start with `409 WOOCOMMERCE_RECONNECT_STORE_MISMATCH`, before any request leaves Akeed. A disconnected organization cannot make Akeed call another host.
- If another organization has connected that store since, `409 WOOCOMMERCE_STORE_UNAVAILABLE`, before any authenticated request. The other organization's webhooks are not touched.
- On success the same integration row becomes active again, with new keys, a new webhook secret and a new delivery address. Orders and history stay attached.
- **Webhooks are replaced, never added to.** The callback lists the store's webhooks and deletes every one that delivers to Akeed before it creates the two new ones. This is also what removes webhooks a failed disconnect left behind.
- `connected_at` moves to the reconnect. **An order placed while the source was disconnected never starts a verification**, even if the store sends it later: it is recorded as `order_predates_connection`.
- `onboarding_status` is unchanged, so a finished account is live again at once.

Refusals a merchant can hit, and what to tell them:

| Code | Meaning | Action |
| --- | --- | --- |
| `WOOCOMMERCE_RECONNECT_STORE_MISMATCH` | Not the store that was connected | Only the original store. A different one needs staff (section 5). |
| `WOOCOMMERCE_STORE_UNAVAILABLE` | Another Akeed account has connected this store | Escalate. Do not move a store between accounts by hand. |
| `WOOCOMMERCE_SOURCE_EXISTS` | The source is not in the disconnected state (still connected, or switched off by staff) | A connected store must be disconnected first. A staff-deactivated one is not the merchant's to reconnect. |
| `WOOCOMMERCE_CREDENTIALS_REJECTED`, `WOOCOMMERCE_PERMISSION_DENIED` | The store refused the new key, or the approving user cannot manage WooCommerce | Approve again as an administrator or shop manager. Each attempt may leave a key in the store to revoke. |
| `WOOCOMMERCE_REST_UNREACHABLE`, `WOOCOMMERCE_PROVIDER_UNAVAILABLE` | The store did not answer in time | Retry. The link stays usable for 15 minutes and 5 attempts. |
| `WOOCOMMERCE_PILOT_REQUIRED`, `WOOCOMMERCE_CONNECT_UNAVAILABLE` | Off the pilot list, or the feature is off | Staff decision. The history stays readable meanwhile. |

Rejected keys (`credentials_rejected`, `permission_denied`) and a deleted webhook are recovered the same way: disconnect, then reconnect. There is no in-place key rotation.

## 5. Support escalation

1. **Merchant → Akeed support.** For anything in Akeed: the connection state, a disabled webhook, refused deliveries, a reconnect that fails.
2. **Akeed support → staff checks.** Read-only, by organization:
   - `GET /api/settings/source-health` as the merchant sees it: credentials, last accepted event, each webhook's state, processing failures, backlog, store-update failures, refused deliveries.
   - `woocommerce_connections`: `store_url`, `health`, `order_created_webhook_state`, `order_updated_webhook_state`, `webhooks_checked_at`, `rejected_deliveries`, `last_rejected_at`, `connected_at`, `disconnected_at`, `disconnected_by`, `woo_version`. Never read or copy the `*_encrypted` columns or `webhook_token_hash`.
   - `woocommerce_pending_installs` for the organization: `last_error_code`, `attempts`, `expires_at`.
   - `webhook_events` for the integration: `status`, `last_error` (for example `integration_inactive`, `order_predates_connection`, `order_not_placed`).
   - `commerce_outcome_syncs` for the integration: `state`, `error_code`, `requires_assistance`.
   - Backend log: `"action":"woocommerce-disconnect"`, `"woocommerce-disconnect-webhook-cleanup"`, `"woocommerce-connection-check"`, `"woocommerce-webhook-read"`, `"woocommerce-webhook-enable"`, `"woocommerce-install-callback"`, `"woocommerce-webhook-refused"`. Each names the store by host only.
3. **Not an Akeed incident: the merchant's hosting or WordPress.** Send the merchant to their hosting provider, with the code and what it means:

| Check result | What it is |
| --- | --- |
| `WOOCOMMERCE_STORE_TLS_FAILED` | The store's certificate is invalid or expired. |
| `WOOCOMMERCE_STORE_ADDRESS_NOT_PUBLIC` | The domain does not resolve, or resolves to a private address. DNS. |
| `WOOCOMMERCE_STORE_REDIRECTS` | The address now redirects (a domain move, a forced `www`). Akeed never follows a redirect. |
| `WOOCOMMERCE_REST_NOT_FOUND` | Plain permalinks, or WooCommerce deactivated. |
| `WOOCOMMERCE_REST_UNREACHABLE` | The store is down, in maintenance, or a firewall blocks Akeed. |
| `WOOCOMMERCE_CREDENTIALS_REJECTED` with a key the merchant did not revoke | The host strips the `Authorization` header (contract record 2.5). |
| `WOOCOMMERCE_WEBHOOK_ENABLE_FAILED` on every attempt | The host refuses `PUT` (contract record 8.4). |

   A custom payment gateway, a custom order status or a plugin that changes the order payload is outside the support boundary. Its orders are recorded as skipped with a reason. Direct the merchant to support and **make no compatibility promise**.

Do not promise the merchant that a reconnect or a re-enable brings back missed orders. It does not.

Requests that need staff and have no self-service path:

- Connecting a different store, or the same store at a new address, to an account that already had one.
- Switching an account to another order source.
- Reconnecting a source that staff deactivated without a disconnect.
- Deleting customer data.

## 6. Reading the health card

Each row is one fact. There is no overall verdict, and a store with no recent events is not a broken one.

| Row | Source | Note |
| --- | --- | --- |
| Access to your store | `woocommerce_connections.health` | `401` is rejected, `403` is denied; both show as rejected. A health read that reaches the store updates it. |
| Last order event received | `webhook_events` | "No events yet" is normal for a store with no new order. |
| Notification for new orders / order changes | Read from the store at that moment | `unknown` when the store did not answer or refused the key. |
| Events refused before processing | `rejected_deliveries` | A wrong signature or source address on a valid token. |
| Processing failures, waiting | `webhook_events` | The common queue, as for every source. |
| Order status updates in your store | `commerce_outcome_syncs` | While `WOOCOMMERCE_OUTCOME_SYNC_ENABLED` is off every outcome is recorded as unsupported, which is not counted as a failure. |

A health read sends two requests to the store and waits 8 seconds at most. A connection check sends three and waits 20 seconds at most. Both go through the restricted outbound client: HTTPS on 443 only, public addresses only, no redirect followed.

## 7. Rollback

- **Feature:** there is no new switch. Connect and reconnect ride on `WOOCOMMERCE_CONNECT_ENABLED` and the pilot list; turning the switch off stops both and leaves disconnect, the check, re-enable, status and health working. Re-enable also needs `WOOCOMMERCE_INGESTION_ENABLED`.
- **Migration `0052_woocommerce_disconnect.sql`:** additive and re-runnable. To remove it, reconnect or delete every `woocommerce_connections` row with `disconnected_at` set (its credentials are gone by design; deleting a connection row keeps the integration, its orders and its verifications), then drop `woocommerce_connections_credentials_state_check` and `woocommerce_connections_webhook_state_check`, `SET NOT NULL` on `consumer_key_encrypted`, `consumer_secret_encrypted`, `webhook_secret_encrypted`, `webhook_token_hash`, `order_created_webhook_id` and `order_updated_webhook_id`, and drop `disconnected_at`, `disconnected_by`, `order_created_webhook_state`, `order_updated_webhook_state` and `webhooks_checked_at`.
- **A disconnect made by mistake:** reconnect the same store (section 4). The integration id and history are unchanged. Orders placed in between are not imported.

## 8. What is UNKNOWN

From the contract record. None of these is assumed in code or in merchant-facing copy; US-07-06 observes them on a real store.

| Unknown | Record | What Akeed does meanwhile |
| --- | --- | --- |
| The status and code for a revoked key, a stripped header and a missing permission | 2.6, 2.8 | `401` is rejected, `403` is denied. The merchant message for a rejection names both the key and the header. |
| Whether a key can be removed through REST | 7.5 | Not attempted. Manual revocation only. |
| Whether re-enabling resets the failure count, and whether it sends a ping | 3.17 | One more failure is assumed to disable it again. A ping after a re-enable is answered `200`. |
| The real failure threshold on a store | 3.14 | The fifth failure in a row is assumed; the store may set another. |
| The exact `X-WC-Webhook-Source` value, and how `home_url` and `site_url` differ | 2.9, 2.16 | Strict equality. A store that spells it differently has its deliveries refused, visibly. |
| Which hosts refuse `PUT` or `DELETE` | 8.4 | A refused re-enable is `WOOCOMMERCE_WEBHOOK_ENABLE_FAILED`; a refused deletion at disconnect is reported as `failed`. |
