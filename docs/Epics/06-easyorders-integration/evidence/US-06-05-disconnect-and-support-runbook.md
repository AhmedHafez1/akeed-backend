# US-06-05 — EasyOrders disconnect, removal and support runbook

- **Written:** 2026-10-03
- **For:** Akeed support and on-call staff, and whoever runs the US-06-06 pilot gate.
- **Source of truth for EasyOrders behavior:** the [US-06-01 contract record](US-06-01-contract-record.md). Where this runbook says UNKNOWN, the record does too. Do not fill those gaps from the public EasyOrders docs.

## 1. What a disconnect does

An owner or admin disconnects from Settings → order source, or from the setup screen when the key was rejected. The API is `DELETE /api/easyorders/connection`. It works with `EASYORDERS_CONNECT_ENABLED=false` and for an organization that is no longer on the pilot list.

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

## 2. What a disconnect does not do: removal at EasyOrders

**Akeed removes nothing at EasyOrders.** This is a decision (product owner, 2026-10-03), and it differs from the cleanup bullet in section 6 of the contract record, which says Akeed tries `DELETE webhooks/delete-by-url` at disconnect and reconnect. That call is not built, for two reasons the record itself states:

- Its auth header is UNKNOWN (the docs page shows `Authorization: Bearer`, every other page shows `Api-Key`).
- Akeed stores only a hash of the webhook URL token, so it cannot rebuild the URL to delete.

It stays owed to go-live step 12 of the record ("Uninstall behavior; delete-by-URL with `Api-Key` and with `Bearer`"). If that step verifies the call, it becomes a new story; storing the token in a recoverable form would also change the record's "stored only as a hash" rule.

The merchant therefore removes Akeed in EasyOrders by hand. The app shows these steps on the disconnected screen and in the disconnect dialog:

1. In EasyOrders, open **Settings → Public API**.
2. Delete the API key named **Akeed**.
3. Under **Webhooks**, delete every webhook named **Akeed** (they are listed with the app name and description).

Until they do:

- EasyOrders keeps the key valid. Akeed no longer holds it, so Akeed cannot use it.
- EasyOrders keeps calling the old webhook address. Every call answers `401` and stores nothing. These calls cannot be counted per merchant, because the token no longer resolves to a connection.

No API-key revocation endpoint is named anywhere in the contract record. Deleting the key in the EasyOrders dashboard is the only known way.

## 3. What is UNKNOWN

From the contract record. None of these is assumed in code or in merchant-facing copy.

| Unknown | Record | What Akeed does meanwhile |
| --- | --- | --- |
| The response to a wrong, missing or revoked key, and how fast revocation takes effect | §2 | `401` and `403` are treated as a permanent rejection (`credentials_rejected`). The app says "the last answer EasyOrders gave, not a live check". |
| Whether EasyOrders keeps calling a URL that answers `401`, or disables it | §6 | Nothing is promised. The merchant is told to delete the webhooks. |
| The auth header of `delete-by-url`, and whether the call works | §6 | Not called. Manual removal only. |
| What EasyOrders does on an app uninstall | §6, step 12 | Not relied on. |
| Whether a webhook secret can be regenerated without recreating the webhook | §7 | A reconnect creates new webhooks with new secrets, and the merchant pastes both again. |
| Whether the callback carries the webhook secrets | §7 | Assumed not. The merchant copies them. |

Because the revoked-key response is unknown and outcome sync ships off, **a key removed at EasyOrders may go unnoticed**: nothing on the webhook path uses the key once the store is verified. Credential health is the last observed answer.

## 4. Reconnect

Only from the disconnected state, and only to the same store. There is one path: the same install link and callback as a first connect (`POST /api/easyorders/install`, then the seller accepts in EasyOrders).

- Needs `EASYORDERS_CONNECT_ENABLED=true` and the organization on `EASYORDERS_PILOT_ORG_IDS`. A disconnect needs neither.
- The callback's `store_id` must equal the one stored. Otherwise `409 EASYORDERS_RECONNECT_STORE_MISMATCH`, and nothing changes.
- If another organization has verified that store since, `409 EASYORDERS_STORE_UNAVAILABLE`.
- On success the same integration row becomes active again, with a new key and a new webhook address. Both webhook secrets are empty, so **orders are refused until the merchant pastes the two new secrets**. Orders placed while disconnected, or before the secrets are pasted, are not imported later.
- The store claim is unverified again and is re-verified on the first order read with the new key.
- A reconnect leaves a second set of Akeed webhooks at EasyOrders if the old ones were not deleted. The old ones answer `401`. Guidance: keep exactly one orders webhook and one order-status webhook for Akeed, and delete the rest.

Refusals a merchant can hit, and what to tell them:

| Code | Meaning | Action |
| --- | --- | --- |
| `EASYORDERS_RECONNECT_STORE_MISMATCH` | They signed in to a different EasyOrders store | Reconnect while signed in to the original store. A different store needs staff (see section 5). |
| `EASYORDERS_STORE_UNAVAILABLE` | Another Akeed account has verified this store | Escalate. Do not move a store between accounts by hand. |
| `EASYORDERS_SOURCE_EXISTS` | The source is not in the disconnected state (still connected, or switched off by staff) | A connected store must be disconnected first. A staff-deactivated one is not the merchant's to reconnect. |
| `EASYORDERS_KEY_REJECTED`, `EASYORDERS_PROVIDER_UNAVAILABLE` | EasyOrders rejected the new key, or could not be reached | Retry. Each attempt leaves a key and webhooks at EasyOrders to delete. |
| `EASYORDERS_PILOT_REQUIRED`, `EASYORDERS_CONNECT_UNAVAILABLE` | Off the pilot list, or the feature is off | Staff decision. The history stays readable meanwhile. |

A revoked key (`credentials_rejected`) is recovered the same way: disconnect, then reconnect. There is no in-place key rotation.

## 5. Support escalation

1. **Merchant → Akeed support.** For anything in Akeed: the connection state, refused orders, a reconnect that fails.
2. **Akeed support → staff checks.** Read-only, by organization:
   - `GET /api/settings/source-health` as the merchant sees it: credentials, last accepted event, processing failures, backlog, store-update failures, refused deliveries.
   - `easyorders_connections`: `health`, `disconnected_at`, `disconnected_by`, `rejected_deliveries`, `last_rejected_at`, `store_verified_at`. Never read or copy the `*_encrypted` columns.
   - `webhook_events` for the integration: `status`, `last_error` (for example `integration_inactive`, `store_mismatch`, `missing_currency`).
   - `commerce_outcome_syncs` for the integration: `state`, `error_code`, `requires_assistance`.
   - Backend log: `"action":"easyorders-disconnect"`, `"easyorders-install-callback"`, `"easyorders-webhook"`.
3. **Akeed staff → EasyOrders.** Only for behavior on the EasyOrders side: a key or webhook that cannot be deleted, deliveries that never arrive, an inactive-store answer the merchant disputes. Contact `info@easy-orders.net` (the contact the contract record lists). Send the store id and the times; never send an API key, a webhook secret or a webhook URL.

Do not promise the merchant that a reconnect is instant or that missed orders will be recovered. Neither is true.

Requests that need staff and have no self-service path:

- Connecting a different EasyOrders store to an account that already had one.
- Switching an account to another order source.
- Deleting customer data. A disconnect is not a privacy redaction; that is a separate authorized workflow.

## 6. Rollback

- **Feature:** there is no new switch. Disconnect and reconnect ride on the existing connect switch; turning `EASYORDERS_CONNECT_ENABLED` off stops new connects and reconnects and leaves disconnect and history working.
- **Migration `0050_easyorders_disconnect.sql`:** additive. To remove it, reconnect or delete every `easyorders_connections` row with `disconnected_at` set (its credentials are gone by design; deleting a connection row keeps the integration, its orders and its verifications), then drop `easyorders_connections_credentials_state_check`, `SET NOT NULL` on `api_key_encrypted`, `webhook_token_hash` and `webhook_token_hint`, and drop `disconnected_at` and `disconnected_by`.
- **A disconnect made by mistake:** reconnect the same store (section 4). The integration id and history are unchanged; the merchant pastes the two new secrets.
