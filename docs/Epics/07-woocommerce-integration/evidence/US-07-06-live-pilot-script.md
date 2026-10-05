# US-07-06 — WooCommerce live pilot script

- **Written:** 2026-10-05
- **Run by:** the product owner, on a WooCommerce store they are authorized to test with and a phone number they own.
- **Status:** NOT RUN. Results go into the release-gate evidence (`US-07-06-release-gate.md`, written after this run), section "Live pilot".
- **Source of truth for WooCommerce behavior:** the [US-07-01 contract record](US-07-01-contract-record.md).

This script proves acceptance criterion 4 of [US-07-06](../US-07-06-woocommerce-release-gate-and-pilot.md) on a real store, and makes the eight observations the contract record hands to this gate (criterion 5). Each observation turns the findings listed beside it from DOCUMENTED or UNKNOWN into VERIFIED.

Nothing here is automated. Every step that touches the store, Meta or the pilot database is yours.

## Rules

- Use a store with **no real customers ordering during the run**. While a switch is off, real orders would be answered `404` and the store would disable Akeed's webhooks after five of them (record, section 3).
- Use a **fresh** Akeed organization with no order source. Never one that has, or had, a Shopify, Standalone or EasyOrders source.
- Place orders only with your own phone number. Real WhatsApp messages are sent from the Akeed sender.
- Never paste a consumer key, a consumer secret, a webhook secret, a delivery URL, a callback URL or an authorize link into the results. For a request, record header **names** and the values of the `X-WC-Webhook-*` headers except `X-WC-Webhook-Signature`; for a body, record its **keys**.
- Save outputs under `akeed-backend/.tmp/pilots/woocommerce/` (gitignored). Do not commit them.
- **Stop at the first result that contradicts the contract record or this script.** Turn the switches off in reverse order (Part I) and write down what you saw. A contradiction opens one focused validation story; it is not worked around.

## What you need

| Item | Why |
| --- | --- |
| A WooCommerce store inside the support boundary: public HTTPS on the default port, pretty permalinks, the core Cash on Delivery gateway enabled, a WordPress user who can manage WooCommerce | The record's support boundary. A store outside it is refused at connect, which is also worth seeing once. |
| The store's checkout set to **classic** (shortcode) checkout for Parts C and D, and to the **Checkout block** for Part E. A second store with the other checkout works too. | Observations 3 and 4. |
| A second payment method that is not Cash on Delivery (Direct bank transfer is enough) | The non-COD order. |
| One product with stock management on and a small stock number | Observation 5 (stock after a cancellation). |
| A view of the requests that reach the Akeed API, with headers and bodies: the ngrok inspector (`http://127.0.0.1:4040`) on the local stack, or the HTTP log of whatever is in front of the deployed API | Observations 1, 2 and 8. Akeed does not log request headers or bodies. |
| `psql` and the pilot database URL in `$env:PILOT_DATABASE_URL` | The reconciliation. |
| A **second API key** in the store, made by hand for the probe: WooCommerce > Settings > Advanced > REST API > Add key, description `Akeed pilot probe`, permission **Read**, for the same WordPress user who approves Akeed | The probe reads what the store answers. Akeed's own key cannot be used: Akeed holds it encrypted and never shows it. If a Read key is refused on `status`, write down the answer (finding 2.8) and use Read/Write. |

The reconciliation, after every step that says "Reconcile":

```powershell
psql "$env:PILOT_DATABASE_URL" -v org_id="'<pilot organization uuid>'" -f scripts/woocommerce-pilot-reconcile.sql > .tmp/pilots/woocommerce/reconcile-<step>.txt
```

It is read-only and selects no credential, token hash, stored payload, phone, name or address.

The probe, where a step says "Probe":

```powershell
$env:WC_PROBE_STORE_URL = 'https://<your store>'
$env:WC_PROBE_KEY = '<the probe key>'
$env:WC_PROBE_SECRET = '<the probe secret>'
node scripts/woocommerce-pilot-probe.mjs order <order id>
```

It only sends `GET`, prints the answer without customer data, masks the delivery URL token, and appends to `.tmp/pilots/woocommerce/api.jsonl`. Commands: `status`, `order <id>`, `notes <id>`, `webhooks`.

## Where each observation is made

| # | Observation (contract record) | Step | Closes |
| --- | --- | --- | --- |
| 1 | The install callback: who sends it, its headers and content type, the type of `user_id`, and whether a refused callback leaves a key in the store | B2, B3 | 1.8, 1.12, 1.13 |
| 2 | The ping: when it arrives, its body, content type and headers, whether it is signed | B3 | 3.9, 3.10 |
| 3 | A COD order on classic checkout: `status`, `payment_method`, which topics fire and in which order | C1 | 4.9, 4.12, 3.18 |
| 4 | A COD order on the Checkout block: the same, plus whether a draft delivery comes first and what its `status` is | E1 | 3.6 to 3.8, 4.7 |
| 5 | Writing `cancelled` from `processing` and from `on-hold`: stock, emails, notes WooCommerce adds | D1, D2 | 5.9 to 5.11 |
| 6 | Whether the confirmation write and the cancellation write come back as `order.updated`, and what the echo carries | C3, D1 | 5.12 |
| 7 | API-key removal is manual; the status and `code` a call gets after the key is revoked | G1, G4 | 2.6, 7.4, 7.5 |
| 8 | The exact `X-WC-Webhook-Source` against the address you typed and `environment.home_url` | B4, C1 | 2.9, 2.15, 2.16 |
| 9 | An order whose billing phone is edited in the store's admin: whether `order.updated` follows, and its status | C5 | The 2026-10-05 gate amendment, rule 1 |

One part of observation 6 cannot be made by this run: **whether the marker is duplicated when the same key is written twice (finding 5.3)**. Akeed never sends the marker when a read already shows it, so a healthy run never repeats the write, and the probe does not write. It stays UNKNOWN with its worst-case rule (any `akeed_outcome` entry with the wanted value counts), which the automated gate exercises against a fake that adds a second entry. Say so if you want a focused write test instead.

## Part A — prepare

1. Deploy the backend and frontend commits named in the release-gate evidence. Migrations `0051` and `0052` run at boot. Confirm Redis is up (the webhook queue and the store-update retry queue need it).
2. Confirm every WooCommerce switch is off, and that an existing Shopify store, a Standalone account and an EasyOrders store, if you have one, still work: place nothing new, read their dashboards.
3. On the backend set, and restart:

   ```text
   WOOCOMMERCE_CONNECT_ENABLED=true
   WOOCOMMERCE_PILOT_ORG_IDS=
   WOOCOMMERCE_PUBLIC_API_BASE_URL=https://<public API host>
   WOOCOMMERCE_APP_BASE_URL=https://<public app host>
   ```

   On the frontend set `NEXT_PUBLIC_WOOCOMMERCE_CONNECT_ENABLED=true` and redeploy.

   An empty pilot list allows **any** organization while connect is enabled. Once the pilot organization exists (step 4), put its UUID in `WOOCOMMERCE_PILOT_ORG_IDS` and restart, so nobody else can connect during the run.
4. Sign up a new account and choose WooCommerce in the source picker. Note the organization's UUID.
5. Leave `WOOCOMMERCE_INGESTION_ENABLED` and `WOOCOMMERCE_OUTCOME_SYNC_ENABLED` off. **Place no order on the store until Part C turns ingestion on.**
6. Reconcile → `reconcile-0-before.txt`. Expected: sections 1 to 3 have no row, every other section is empty.

## Part B — connect

Write the wall-clock time next to each step, and what the screen showed.

### B1. A store that is refused, and a refusal by you

1. Enter the store's address with `http://`. Expected: the HTTPS message, nothing sent to the store.
2. Enter the correct address. On the store's approval page click **Deny**. Expected in Akeed: the denied state, an offer to try again, "nothing was connected". Reconcile section 3: one row, `consumed = f`, `attempts = 0`.

### B2. A callback that is refused (observation 1, finding 1.13)

1. Start again. On the store's approval page **wait 16 minutes**, then click **Approve**. The install context has expired, so Akeed answers the callback `401`.
2. Write down what the store's page did after Akeed refused: an error, a redirect back, nothing.
3. Open WooCommerce > Settings > Advanced > REST API. **Is there a new key for Akeed?** This is the answer to "does a refused callback leave a key in the store". If there is one, revoke it.
4. In the request view, find the `POST …/api/woocommerce/install/callback/…` and record for observation 1: the `User-Agent`, the `Content-Type`, whether `Origin`, `Referer` or `Cookie` is present (a browser sends them; a server does not), the body's **keys**, and whether `user_id` is a JSON number or a JSON string. Do not copy `consumer_key` or `consumer_secret`.

### B3. Approve (observations 1 and 2)

1. Start again and click **Approve** at once.
2. Expected in Akeed: the waiting state for a moment, then connected, naming the store by the address you typed. Backend log: `"action":"woocommerce-install-callback"` with `"outcome":"success"`.
3. In the request view, in the order they arrived: the callback `POST`, and the requests to `…/api/woocommerce/webhooks/…` that follow it. Those are the **pings**. Record for observation 2: how many, when relative to the callback, each one's `Content-Type`, which `X-WC-Webhook-*` headers it has (names, and values except the signature), whether it has a signature at all, its body, and that Akeed answered each `200`.
4. In WooCommerce > Settings > Advanced > Webhooks: exactly two webhooks, `Akeed order created` and `Akeed order updated`, both Active. In REST API: exactly one key for Akeed with Read/Write.
5. Probe: `webhooks`. Expected: the two Akeed webhooks, `secret_returned: false`.

### B4. Health and the store's own name (observation 8)

1. Finish the Akeed setup checklist, including the free test message to your own number.
2. Open Settings → Store. Click **Check connection**. Expected: nothing needs attention; both order notifications active.
3. Probe: `status`. Write down `home_url` and `site_url` beside the address you typed. They are compared with the `X-WC-Webhook-Source` you will see in C1.
4. Reconcile → `reconcile-1-connected.txt`. Expected section 1: `is_active = t`, `onboarding_status = completed` once the checklist is finished, `store_verified = t`, `health = ok`, the four `*_set` columns `t`, both webhook states `active`, `rejected_deliveries = 0`. Section 3: the last row `consumed = t`.

If the store reports a different address from the one you typed, the connect is refused with `WOOCOMMERCE_STORE_URL_MISMATCH`. That is the record's rule working, and an answer to observation 8 in itself: write down both values.

## Part C — the journey on classic checkout

### C1. A COD order (observations 3 and 8)

1. Set `WOOCOMMERCE_INGESTION_ENABLED=true` and restart.
2. Place a COD order on the storefront, classic checkout, with your own phone number.
3. Expected: one WhatsApp message from the Akeed sender within a minute; the order on the Akeed dashboard as Sent, with the store's currency and your number in international format.
4. In the request view, the deliveries for this order. Record for observation 8 the exact `X-WC-Webhook-Source`; for observation 3 the `X-WC-Webhook-Topic` of each and their order of arrival, and the `Content-Type`.
5. Reconcile → `reconcile-2-sent.txt`. Section 5 is the record of observation 3: the topics in the order they arrived, the route Akeed chose, `order_status` and `payment_method`. Expected by Akeed's rules: exactly one `order.create` row, `completed`; if both topics fired, one `order.update` row, `skipped` with `remote_status_observed`. Section 7: one line, `sends = 1`, `initial:…:akeed_system`. Section 10: `usage_consumed = 1`, `sends_not_from_akeed_sender = 0`. Sections 6, 8, 9 empty.
6. Probe: `order <id>` and `notes <id>`. Keep them: this is the order before Akeed writes anything.

`rejected_deliveries` above 0 in section 1 means a delivery failed the signature or the source check. If it is the source, the value you recorded in step 4 says why: stop, this is observation 8 contradicting the record.

### C2. A duplicate delivery

1. In the request view, **replay** the `order.created` delivery of C1 exactly as it was sent. Then replay it again.
2. Expected: Akeed answers `200` both times. Reconcile → `reconcile-3-duplicate.txt`: the two replays together add at most one `order.update` row for the same store order, `skipped` with `remote_status_observed` (a repeat of an order Akeed already has is an update of it), and none if C1 already recorded one for the order in this state. The second replay never adds a row. Sections 7 and 10 are unchanged: one order, one verification, one send, one usage unit.
3. Without a replay button: open the order in WooCommerce admin and click **Update** twice without changing anything. Record what arrived.

### C3. The customer confirms (observation 6)

1. Do **not** answer yet. Set `WOOCOMMERCE_OUTCOME_SYNC_ENABLED=true` and restart.
2. Tap **Confirm** in WhatsApp.
3. Expected in Akeed: Confirmed, and the store update shown as done.
4. Expected in WooCommerce, on the order: the status **unchanged** (still Processing); one private note `Akeed: order confirmed. / أكيد: تم تأكيد الطلب.`; a custom field `akeed_outcome` whose value starts with `customer_confirmation:`. No email to the customer. Write down anything else that changed.
5. Probe: `order <id>` and `notes <id>`. Expected: `akeed_markers` has exactly one entry; the note is there once with `customer_note: false`.
6. Wait two minutes. Reconcile → `reconcile-4-confirmed.txt`. Section 11: `customer_confirmation / succeeded / processing`. Section 5 answers observation 6 for a confirmation: **did an `order.updated` arrive after Akeed's write?** If it did, it is `skipped` with `reflected_outcome` and `akeed_markers = 1`. If none arrived, write that down: a meta-only write does not come back.

### C4. An order paid another way

1. Place an order with the non-COD method.
2. Expected: no message. Reconcile → `reconcile-5-non-cod.txt`: section 5 has an `order.skip` row with that `payment_method` and `non_cod_payment_method`; `usage_consumed` unchanged; no new line in section 7.

### C5. An order you correct in the store (observation 9)

1. Place a COD order on classic checkout with a phone number that is not a mobile number, for example `12345`.
2. Expected: no message. Reconcile → `reconcile-5b-unreadable.txt`: section 5 has an `order.create` row for it, `skipped` with `invalid_phone`; no new line in section 7; `usage_consumed` unchanged.
3. In WooCommerce admin, open the order, set the billing phone to your own number, and click **Update**. Change nothing else.
4. In the request view: **did an `order.updated` delivery arrive?** Record its `status`. This is observation 9.
5. Expected if it arrived with the order still Processing or On hold: one WhatsApp message to the corrected number within a minute. Reconcile → `reconcile-5c-corrected.txt`: section 5 has an `order.retry` row, `completed`; section 7 has one line for the order with `sends = 1`; `usage_consumed` is up by one; sections 8 and 9 are empty.
6. If none arrived, write that down: on this store a corrected order is not sent again, and it stays unverified.
7. Answer or ignore the message as you like; it is not part of a later step.

## Part D — cancellation and an order nobody answers

### D1. The customer cancels, from Processing (observations 5 and 6)

1. Note the stock of the product. Place a COD order for it. Note the stock again.
2. Tap **Cancel** in WhatsApp.
3. Expected: Akeed Canceled; WooCommerce Cancelled, with the `akeed_outcome` field starting `customer_cancellation:`, and no note of Akeed's.
4. Write down for observation 5: the stock now; every email the customer address and the store admin address received, with its subject; every note WooCommerce itself added to the order.
5. Probe: `order <id>` and `notes <id>`.
6. Reconcile → `reconcile-6-cancelled.txt`. Section 11 gains `customer_cancellation / succeeded / cancelled`; `usage_consumed` is one higher. Section 5, for observation 6: the `order.updated` that followed, `order_status = cancelled`, `reflected_outcome`.

### D2. The customer cancels, from On hold (observation 5)

1. Place a COD order. In WooCommerce admin set it to **On hold** before answering.
2. Tap **Cancel**. Expected: WooCommerce Cancelled. Write down the same things as D1.4, and say whether anything differed from D1.
3. If the store refuses the change, Akeed shows the store update as failed (`remote_rejected` in section 11) and does not retry. Write down what the order shows. That is an answer to finding 5.11, not a failure of the run.

### D3. An order nobody answers

1. Place a COD order and do not answer. Wait for the reminder and then for the no-reply escalation (the delays are in Settings → Automation; shorten them for the pilot account if you wish, and note the values).
2. Expected: Akeed shows No reply. **WooCommerce still shows the order as Processing, with no note and no `akeed_outcome` field.** Akeed must not have written anything.
3. Probe: `order <id>` and `notes <id>`. Expected: `akeed_markers` empty.
4. Reconcile → `reconcile-7-noreply.txt`. Section 11 has `automatic_no_reply_tagging / unsupported`; section 12 is empty.
5. In Akeed, cancel the order yourself (the row action on a no-reply order). Expected: WooCommerce Cancelled; section 11 gains `merchant_no_reply_cancellation / succeeded / cancelled`.

## Part E — the Checkout block pass

### E1. A COD order on the Checkout block (observation 4)

1. Switch the store's checkout page to the Checkout block, or use the second store (connect it with a second fresh organization, Parts A and B).
2. Add a product to the cart and open the checkout page. **Do not place the order yet.** Fill in the form slowly, choose Cash on Delivery, and wait one minute. Watch the request view: does a delivery arrive before you place the order?
3. Place the order.
4. Expected: exactly one WhatsApp message.
5. Reconcile → `reconcile-8-block.txt`. Section 5 is the record of observation 4. If a draft delivery came first it is an `order.skip` row with `order_not_placed`: **write down its `order_status`**, which is the value the documentation does not give (finding 4.7), and its topic. The placed order is one `order.create` row, `completed`, on whichever topic carried it. Section 7: one new line with `sends = 1`. Sections 8 and 9 empty.
6. If no draft delivery arrived, write that down with the WooCommerce version from B4.3: on this version the block creates the draft at Place order (finding 3.7).
7. Confirm this order in WhatsApp and check the note and the field as in C3.

## Part F — reconciliation of the whole run

Reconcile → `reconcile-9-all.txt`. For every order you placed there must be:

- at most one line in section 7, and exactly one for every COD order placed while ingestion was on;
- `sends` and the send detail as expected, all `akeed_system`;
- `usage_consumed` equal to the number of orders that were sent;
- one store update per customer answer, whose `provider_status` is the status WooCommerce shows;
- nothing in sections 6, 8, 9, 12, 13 and 14.

## Part G — key removal, disconnect and reconnect

### G1. What a revoked key answers (observation 7)

1. Probe: `status`. Expected `200`.
2. In WooCommerce > Settings > Advanced > REST API, revoke the **probe** key.
3. Probe: `status` again, at once and after one minute. The `http_status` and the `code` are the answer to finding 2.6. Make a new probe key for the rest of the run.

### G2. Disconnect

1. Reconcile → `reconcile-10-before-disconnect.txt`.
2. In Akeed Settings → Store, disconnect. Read what the screen says about the store's side.
3. In WooCommerce: are the two Akeed webhooks gone from Settings > Advanced > Webhooks? Is Akeed's key **still listed** under REST API? It should be: Akeed makes no call to remove a key (findings 7.4 and 7.5). Revoke it by hand, as the screen tells you to.
4. Place a COD order. Expected: nothing arrives in Akeed; no message.
5. Reconcile → `reconcile-11-disconnected.txt`. Expected: sections 4, 7, 10 and 11 unchanged from step 1; section 1 `is_active = f`, the four `*_set` columns `f`, `disconnected_at` set.

### G3. Reconnect the same store

1. In Akeed, reconnect. Approve in the store. Expected: connected again, with a new key and two new webhooks in the store, and nothing left of the old ones.
2. Try once to reconnect with a **different** store address. Expected: refused, `WOOCOMMERCE_RECONNECT_STORE_MISMATCH`, nothing sent to that address.
3. Place a COD order and confirm it.
4. Reconcile → `reconcile-12-reconnected.txt`. Expected: the same `integration_id` as before; every earlier order still in section 7; the order placed while disconnected is **not** there (it is never imported later); one more order, send, usage unit and store update.

### G4. Akeed's own key revoked while connected (observation 7)

1. Place a COD order and do not answer.
2. In WooCommerce, revoke **Akeed's** key.
3. In Akeed click **Check connection**. Expected: the store did not accept Akeed's access; the panel shows the credentials as rejected and offers a reconnect.
4. Tap **Confirm** in WhatsApp. Expected: Akeed Confirmed; the store update shown as failed and needing you, not retried; the order in WooCommerce untouched.
5. Reconcile → `reconcile-13-revoked.txt`. Section 1 `health` is `credentials_rejected` or `permission_denied`: **which one** is the other half of finding 2.6. Section 11: `customer_confirmation / failed / … / source_credentials_rejected` or `source_permission_denied`, `requires_assistance = t`.
6. Disconnect. Expected: the screen says the store's webhooks could not be removed. Delete the two Akeed webhooks in WooCommerce by hand, then reconnect. If the failed store update offers **Retry**, use it and check that the note and the field arrive; if it does not, write that down.

## Part H — localized walkthrough (needs your eyes)

These screens are behind login, so the agent did not look at them. Check each row in Arabic (`/ar`, RTL) and English (`/en`), in light and dark, on the pilot account. Write "ok" or what was wrong, per locale and theme.

| # | Screen and state | Check |
| --- | --- | --- |
| 1 | Signup with the source picker | WooCommerce is offered; Standalone signup is unchanged when the flag is unset |
| 2 | Connect: enter the store address | The address field reads left to right inside the Arabic page; the consent text names reading orders, updating orders and the Akeed sender |
| 3 | Connect: checking, then a refused address (`http://`, a site that is not WooCommerce, an address that redirects) | Each code has its own sentence; none shows the code itself |
| 4 | Back from the store: waiting | The store is named by its address; no key, token or link on screen |
| 5 | Back from the store: denied (B1.2) | Says nothing was connected; offers to try again |
| 6 | Expired install (B2) | Tells you a key may be left in the store and where to revoke it |
| 7 | Not on the pilot list | The pilot message, localized, no retry loop |
| 8 | Connected, setup checklist and free test | Store, order notifications, Akeed sender; the stepper names the WooCommerce step |
| 9 | Dashboard and Verifications | Order source; the store-update state apart from the verification result; the failed-update Retry (G4.6); the reason shown for the non-COD order and the draft |
| 10 | Settings → Store: the panel and the health card | Store address, order notifications, last accepted event, refused deliveries; "no events yet" is not shown as a fault |
| 11 | Check connection, with nothing wrong and with the key revoked (G4.3) | The result reads as sentences; the time of the check is localized |
| 12 | A paused webhook: pause `Akeed order updated` in WooCommerce, then Check connection | Shown as paused, with no button that overrides it; set it back to Active afterwards |
| 13 | Credentials rejected (G4.3) | Says it is the store's last answer; offers reconnect |
| 14 | Disconnect dialog | Keyboard: Tab order, Escape closes, focus returns; the key-removal steps |
| 15 | Disconnected, and reconnect | Read-only notice; the key-removal steps; reconnect says it must be the same store |
| 16 | A reconnect you deny in the store, started from Settings | Lands on Settings → Store showing the denied state, not "waiting" (fixed in this gate) |
| 17 | Wrong store on reconnect (G3.2) | The store-mismatch message |
| 18 | Shopify embedded app, an existing store | Dashboard, Verifications, Settings and billing open and behave as before; no WooCommerce wording |
| 19 | Standalone account, an existing one | Dashboard, manual order, import, API keys and billing behave as before; no source picker when both flags are unset |
| 20 | EasyOrders account, if you have one | Connect screen, settings panel and disconnect dialog look and behave as before (they now share components with WooCommerce) |

## Part I — what to hand back

Every reconcile file as it is. Plus:

| Item | How to capture it without secrets |
| --- | --- |
| The observation notes | The table under "Where each observation is made", with what you saw for each row and the step's time. |
| The callback and the pings (B2.4, B3.3) | Header names, the header values named in those steps, body keys, the type of `user_id`. Never the keys. |
| A delivery's headers (C1.4, E1) | `Content-Type` and every `X-WC-Webhook-*` value except the signature. |
| Real API responses | `.tmp/pilots/woocommerce/api.jsonl` from the probe. It holds no key, token, phone, name or address; read it once before sending anyway. |
| `GET /api/settings/source-health` after C3, D3 and G4.3 | Copy the JSON from the browser's network panel. It contains no credential. |
| Backend log lines | The lines with `"action":"woocommerce-install-callback"`, `"woocommerce-webhook-accept"`, `"woocommerce-webhook-refused"`, `"woocommerce-outcome-sync"`, `"woocommerce-connection-check"` and `"woocommerce-disconnect"` for the pilot organization. The log redacts secrets; check before sending anyway. |
| Side effects in WooCommerce | Your notes from C3.4, D1.4 and D2.2, with times. Screenshots must not show the REST API key page or a webhook's edit page. |
| The store | WordPress and WooCommerce versions, classic or block checkout for each part, and whether the store is at a domain root or in a subdirectory. |
| The walkthrough | The Part H table, per locale and theme. |

## Part J — stop and roll back

Turn things off in the reverse of the order they were turned on. None of these touches a Shopify, Standalone or EasyOrders setting, queue or route.

- **Stop store updates:** `WOOCOMMERCE_OUTCOME_SYNC_ENABLED=false`. Customer answers stay in Akeed and show as not sent to the store.
- **Stop ingestion:** `WOOCOMMERCE_INGESTION_ENABLED=false`. Order deliveries answer `404`; orders placed meanwhile are not imported later, and after five of them the store disables the webhooks. For a store that must stay connected, prefer disconnecting it.
- **Stop new connections only:** `WOOCOMMERCE_CONNECT_ENABLED=false`, and unset `NEXT_PUBLIC_WOOCOMMERCE_CONNECT_ENABLED`. Connected stores keep working; status, health and disconnect still work.
- **Stop one organization only:** leave the switch on and take its UUID out of `WOOCOMMERCE_PILOT_ORG_IDS`, **keeping at least one other UUID in the list**. An empty list allows every organization.
- **Remove the pilot store:** disconnect in Akeed, then revoke Akeed's key and, if the screen says they were left, delete the Akeed webhooks in WooCommerce. History stays.

The support procedures for a disabled webhook, a rejected key and a reconnect are in the [US-07-05 runbook](US-07-05-disconnect-and-support-runbook.md).
