# US-06-06 — EasyOrders live pilot script

- **Written:** 2026-10-03
- **Run by:** the product owner, on a store they are authorized to test with and a phone number they own.
- **Status:** NOT RUN. Results go into the [release-gate evidence](US-06-06-release-gate.md), section "Live pilot".
- **Source of truth for EasyOrders behavior:** the [US-06-01 contract record](US-06-01-contract-record.md).

This script proves acceptance criterion 1 of [US-06-06](../US-06-06-easyorders-contract-and-pilot-release-gate.md) on a real store: install → COD order → Akeed send → customer outcome → EasyOrders status. It also closes the go-live verification the contract record still owes, because the pilot must not run on behavior that is UNKNOWN.

Nothing here is automated. Every step that touches EasyOrders, Meta or the pilot database is yours.

## Rules

- Use one **active** EasyOrders store (wallet topped up). An inactive store answers every API call with `400` and sent no webhook in the first run. Part A's last two rows need a second store.
- Use a **fresh** Akeed organization that has no order source. Do not use an organization that has, or had, a Shopify or Standalone source.
- Place orders only with your own phone number. Real WhatsApp messages are sent from the Akeed sender.
- Never paste an API key, a webhook secret, a webhook URL or an install link into the results. Record fingerprints (the spike kit prints them) or "set / not set".
- Save outputs under `akeed-backend/.tmp/pilots/easyorders/` (gitignored). Do not commit them.
- Stop at the first step whose result contradicts the contract record or this script. Switch the three EasyOrders switches off (Part F) and write down what you saw. A contradiction reopens the story it belongs to.

## Part A — the owed US-06-01 verification (before the pilot)

Run these steps of the [spike test plan](../../../../scripts/spikes/easyorders/README.md) against the active store, with the capture server (port 3199, its own tunnel; not the Akeed API). They are numbered as in that file.

| Step | Closes (record section) | Must be observed | Blocks |
| --- | --- | --- | --- |
| 1, 4 | 1, 2, 7 | The callback POST: header names, body keys, whether a webhook secret is in it; the redirect; cancel and closed tab | Connect |
| 5 | 2, 3, 4 | A real order webhook: headers, the `secret` header, the full payload; storefront versus dashboard-created order. Make the captured fixture with `sanitize-fixture.mjs` | Ingestion |
| 5 (`get-order`) | 2, 5 | The response shape of `GET orders/:id`: is the order at the top level, with `store_id` and `status`? And what a valid key answers for an order id that does not exist | Connect, outcome sync |
| 6 | 3 | Retries after `5xx` and after a timeout; duplicates; ordering | Ingestion |
| 7 | 6 | A real status webhook on a token URL; the same after the token is revoked | Ingestion |
| 8 | 2 | The answers to a wrong, a missing and a revoked key; how fast a revocation takes effect | Outcome sync, health |
| 10 | 5 | `pending → confirmed` and `pending → canceled` through the API: the response, the customer notifications, stock, shipping push, refunds, and whether the change comes back as a status webhook | Outcome sync |
| 11 | 8 | The first `429`: its headers, its body, the recovery time | Outcome sync |
| 12 | 6 | Uninstall behavior; `delete-by-url` with `Api-Key` and with `Bearer` | Cleanup guidance |
| 7, 8 on a second store | 2, 6 | A key cannot read another store's order; one store's events never reach another store's URL | Release |
| 11 with a second key | 8 | Whether two keys share one limit | Release |

Two answers decide whether Part C can work at all. Check them before going on:

1. **A valid key on an unknown order id.** Akeed's install probe reads an order that cannot exist and accepts the key only on a `2xx` or on the inactive-store `400`. If an active store answers `404`, every install is refused with `EASYORDERS_KEY_REJECTED`. That is a defect to fix before the pilot, not something to work around.
2. **The shape of `GET orders/:id`.** Akeed expects `store_id` and `status` at the top level and fails closed otherwise (`store_unverified`, `remote_state_unreadable`). A different shape means no store update succeeds.

Hand the results back so the contract record can be updated. Part B starts only when the record has no UNKNOWN in the "Blocks" column for the switch you are about to turn on.

## Part B — prepare the pilot organization

1. Deploy the backend commit named in the release-gate evidence. Migrations 0047 to 0050 run at boot. Confirm Redis is up (the outcome retry queue needs it).
2. Confirm all three switches are off and Shopify is healthy: place nothing, just read the logs for `webhook-ingest` on a Shopify store you already have.
3. Create the pilot account with the source picker. That needs `NEXT_PUBLIC_EASYORDERS_CONNECT_ENABLED=true` on the frontend and, first, on the backend:

   ```
   EASYORDERS_CONNECT_ENABLED=true
   EASYORDERS_PILOT_ORG_IDS=
   EASYORDERS_PUBLIC_API_BASE_URL=https://<public API host>
   EASYORDERS_APP_BASE_URL=https://<public app host>
   ```

   An empty pilot list allows any organization while connect is enabled. For a restricted pilot, set the organization's UUID instead.
4. Leave `EASYORDERS_INGESTION_ENABLED` and `EASYORDERS_OUTCOME_SYNC_ENABLED` off.
5. Run the reconciliation and save it as `reconcile-0-before.txt`:

   ```powershell
   psql "$env:PILOT_DATABASE_URL" -v org_id="'<pilot organization uuid>'" -f scripts/easyorders-pilot-reconcile.sql > .tmp/pilots/easyorders/reconcile-0-before.txt
   ```

   Expected: section 1 has no row, every other section is empty.

## Part C — the journey

Write the wall-clock time next to each step. After each numbered step, note what the screen showed.

### C1. Install

1. In Akeed, as the owner, start the connection. Accept in EasyOrders.
2. Expected in Akeed: the connected screen, the store id, health "ok", and "action needed: add webhook secrets". Backend log: `"action":"easyorders-install-callback"` with `outcome":"success"`.
3. In EasyOrders **Settings → Public API**: exactly one API key and two webhooks named Akeed. If earlier attempts left more, delete the extra ones now and note how many there were.
4. Paste the two webhook secrets (orders, status) and choose currency and phone country. Finish the Akeed setup, including the free test message to your own number.
5. Reconcile → `reconcile-1-installed.txt`. Expected section 1: `is_active = t`, `onboarding_status = completed`, `store_verified = f`, `api_key_set`, `webhook_address_set`, `orders_secret_set`, `status_secret_set` all `t`.

### C2. A COD order that the customer confirms

1. Set `EASYORDERS_INGESTION_ENABLED=true` and restart.
2. Place a COD order on the storefront with your own phone number.
3. Expected: one WhatsApp message from the Akeed sender within a minute; the order on the Akeed dashboard as Sent, with the store's currency and the number in international format.
4. Reconcile → `reconcile-2-sent.txt`. Expected: section 1 `store_verified = t`; section 3 one `order.create` event `completed`; section 5 one line with `sends = 1` and `initial:...:akeed_system`; section 8 `usage_consumed = 1`, `sends_not_from_akeed_sender = 0`; sections 4, 6, 7 empty.
5. Do **not** answer yet. Set `EASYORDERS_OUTCOME_SYNC_ENABLED=true` and restart.
6. Tap **Confirm** in WhatsApp.
7. Expected in Akeed: Confirmed, and the store update shown as done. Expected in EasyOrders: the order is `confirmed`. Write down every side effect you see in EasyOrders and on your phone: notifications, stock, shipping push.
8. Reconcile → `reconcile-3-confirmed.txt`. Expected: section 9 one `customer_confirmation / succeeded / confirmed`; section 3 gains one `order.update` event that is `skipped` with `reflected_outcome` if EasyOrders echoes the change (record whether it does); section 11 empty.

### C3. A COD order that the customer cancels

1. Place a second COD order. Tap **Cancel**.
2. Expected: Akeed Canceled; EasyOrders `canceled`. Write down the side effects (refund, stock, notifications).
3. Reconcile → `reconcile-4-canceled.txt`. Expected: section 9 gains `customer_cancellation / succeeded / canceled`; `usage_consumed = 2`.

### C4. An order nobody answers

1. Place a third COD order and do not answer. Wait for the reminder and then for the no-reply escalation (the delays are in Settings → Automation; shorten them for the pilot account if you wish, and note the values).
2. Expected: Akeed shows No reply. **EasyOrders still shows the order as pending (Under Review).** Akeed must not have changed it.
3. Reconcile → `reconcile-5-noreply.txt`. Expected: section 9 has `automatic_no_reply_tagging / unsupported`; section 10 empty.
4. In Akeed, cancel the order yourself (the row action on a no-reply order). Expected: EasyOrders `canceled`; section 9 gains `merchant_no_reply_cancellation / succeeded / canceled`.

### C5. Duplicates and a non-COD order

1. If the store still has a duplicate Akeed webhook from an earlier install, place one order and confirm in section 7 that it was stored once. Section 1 `rejected_deliveries` counts the delivery that carried the other secret.
2. If the store offers an online payment method, place one such order. Expected: no message; section 3 shows the event `skipped`; `usage_consumed` unchanged.

### C6. Disconnect and reconnect

1. Reconcile → `reconcile-6-before-disconnect.txt`.
2. In Akeed Settings → order source, disconnect. Follow the removal steps the screen shows in EasyOrders (delete the key and the webhooks named Akeed). Note whether anything refused to delete.
3. Place a COD order. Expected: nothing arrives in Akeed; no message.
4. Reconcile → `reconcile-7-disconnected.txt`. Expected: sections 3, 5, 8 and 9 unchanged from step 1; section 1 `is_active = f`, the four `*_set` columns `f`, `disconnected_at` set.
5. Reconnect the same store, paste the two new secrets, place a COD order and confirm it.
6. Reconcile → `reconcile-8-reconnected.txt`. Expected: the same `integration_id` as before; every earlier order still listed in section 5; one more order, send, usage unit and store update.

## Part D — what to hand back

For each reconcile file, the file itself (it contains no credential, phone, name or address). Plus:

| Item | How to capture it without secrets |
| --- | --- |
| Real API responses: `GET orders/:id` before and after each status write, the status write itself | `node scripts/spikes/easyorders/api-probe.mjs get-order` and the step-10 commands; the kit stores keys as fingerprints. Hand back the lines of `api.jsonl` for the pilot orders. |
| Real webhook deliveries | Not captured by Akeed in clear. Use the Part A captures for shape; for the pilot, section 3 and 5 of the reconcile files are the record. |
| `GET /api/settings/source-health` after C2.8, C4.4, C6.4 and C6.6 | Copy the JSON from the browser's network panel. It contains no credential. |
| Backend log lines | The lines with `"action":"easyorders-install-callback"`, `"easyorders-webhook"`, `"easyorders-outcome-sync"`, `"commerce-outcome-dispatch"`, `"easyorders-disconnect"` for the pilot organization. The log redacts secrets; check before sending anyway. |
| Side effects in EasyOrders | Your notes from C2.7 and C3.2, with times. Screenshots must not show the Public API page. |
| Counts in EasyOrders | For each pilot order: its id's first eight characters, its final status, and the time it changed. |

The reconciliation is then: for every order in EasyOrders, one accepted event, one order, one verification, the sends listed, the usage units counted, and one store update whose `provider_status` equals the status EasyOrders shows.

## Part E — localized walkthrough (needs your eyes)

These screens are behind login, so they were not looked at by the agent. Each row is checked in Arabic (`/ar`, RTL) and English (`/en`), in light and dark, on the pilot account.

| # | Screen and state | Check |
| --- | --- | --- |
| 1 | Signup with the source picker | EasyOrders is offered; Standalone signup is unchanged when the flag is unset |
| 2 | Connect screen, before the install | Consent text names reading orders, updating status and the Akeed sender |
| 3 | Not on the pilot list | `EASYORDERS_PILOT_REQUIRED` message, localized, no retry loop |
| 4 | Waiting, denied or expired install | The removal steps for the orphan key and webhooks are shown |
| 5 | Connected, secrets missing | The webhook URLs show only their last characters; no key, token or secret anywhere |
| 6 | Setup checklist and free test | Store, country and currency, secrets, Akeed sender; the stepper names the EasyOrders step |
| 7 | Dashboard and Verifications | Order source, the store-update state apart from the verification result, the failed-update retry |
| 8 | Settings → order source, health card | Credentials, last accepted event, processing failures, store-update failures; "no events yet" is not shown as a fault |
| 9 | Disconnect dialog | Keyboard: Tab order, Escape closes, focus returns; the removal steps |
| 10 | Disconnected and reconnect | Settings read-only notice; reconnect says it must be the same store |
| 11 | Revoked key | "The last answer EasyOrders gave, not a live check" |
| 12 | Wrong store on reconnect | `EASYORDERS_RECONNECT_STORE_MISMATCH` message |
| 13 | Shopify embedded app, an existing store | Dashboard, Verifications, Settings and billing open and behave as before; no EasyOrders wording |
| 14 | Standalone account, an existing one | Dashboard, manual order, import, API keys and billing behave as before; no source picker when the flag is unset |

Write "ok" or what was wrong, per locale and theme.

## Part F — stop and roll back

- **Stop new connections only** (Shopify and existing EasyOrders stores keep working): `EASYORDERS_CONNECT_ENABLED=false`, and unset `NEXT_PUBLIC_EASYORDERS_CONNECT_ENABLED`. Details in the release-gate evidence, "Pausing new connections".
- **Stop store updates:** `EASYORDERS_OUTCOME_SYNC_ENABLED=false`. Customer answers stay in Akeed.
- **Stop ingestion:** `EASYORDERS_INGESTION_ENABLED=false`. Both webhook addresses answer `404`; orders placed meanwhile are not imported later.
- **Remove the pilot store:** disconnect in Akeed, then delete the Akeed key and webhooks in EasyOrders. History stays.
- None of these touches a Shopify or Standalone setting, queue or route.
