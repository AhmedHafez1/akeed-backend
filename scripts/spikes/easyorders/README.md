# EasyOrders validation spike — test plan (US-06-01)

This kit produces the evidence for
[US-06-01](../../../docs/Epics/06-easyorders-integration/US-06-01-easyorders-integration-validation.md).
It is not production code and nothing in `src/` depends on it.

The findings go into
`docs/Epics/06-easyorders-integration/evidence/US-06-01-contract-record.md`
after the steps below have been run against a test store.

## Rules

- Use only a store you are authorized to test with. Place test orders with a phone number you own.
- Credentials are read from environment variables. Do not put them in a file in this repository, and do not paste them into the results you hand back.
- Evidence is written to `.tmp/spikes/easyorders/` (gitignored). API keys, the `secret` header and URL tokens are stored as a 12-character SHA-256 fingerprint (`fp`), which is enough to tell whether two values are the same.
- `capture.jsonl` contains the customer fields of your test orders. It stays local. Fixtures are made from it with `sanitize-fixture.mjs`.
- Scripts marked **live** call the EasyOrders API or change the test store.

## Setup

PowerShell, from `akeed-backend`:

```powershell
$env:EO_PUBLIC_BASE_URL = 'https://<your-tunnel-host>'   # public HTTPS URL of the capture server
$env:EO_CAPTURE_PORT    = '3199'
node scripts/spikes/easyorders/capture-server.mjs
```

Point the tunnel at port 3199, for example `ngrok http 3199`. Port 3000 is the Akeed API, so don't reuse that tunnel while the API is running.

In a second terminal, set these as they become known:

| Variable             | Set after                                      | Used by                                   |
| -------------------- | ---------------------------------------------- | ----------------------------------------- |
| `EO_PUBLIC_BASE_URL` | starting the tunnel                            | `build-install-link.mjs`                  |
| `EO_API_KEY`         | step 1 (you create a dashboard key, see below) | `api-probe.mjs`, `rate-burst.mjs`         |
| `EO_ORDER_ID`        | step 5                                         | `api-probe.mjs`, `rate-burst.mjs`         |
| `EO_WEBHOOK_SECRET`  | step 4, if the dashboard shows one             | `capture-server.mjs` (restart it)         |
| `EO_API_KEY_2`       | step 11, if a second key or store exists       | `rate-burst.mjs`, `api-probe.mjs --key 2` |

The capture server never stores the `api_key` from the install callback, so the probes need a key you can read. Create one in the seller dashboard (**Public API → Create New API Key**) and compare its fingerprint with the callback's: `api.jsonl` records `keyFp`, `capture.jsonl` records `body.api_key.fp`.

## Steps

Each step lists who acts, the command, and what to write down. "Capture" means the line appears in the capture-server console and in `capture.jsonl`; nothing has to be copied by hand.

### 1. Install: accept (AC 1, 2)

```powershell
node scripts/spikes/easyorders/build-install-link.mjs --label storeA
```

You: open the printed link while signed in to the test store and accept.

Write down:

- What the consent page shows (app name, icon, permissions, the webhook URLs?).
- Whether the browser lands on the `redirect_url`, and with which query parameters (capture: `kind: "done"`).
- Capture `kind: "cb"`: method, `headerNames`, body keys. Is there anything besides `api_key` and `store_id`? Is there any header that could authenticate the caller?
- Whether the callback arrives before or after the redirect.

Then repeat with the token in the query string, to learn whether EasyOrders keeps a query on our URLs:

```powershell
node scripts/spikes/easyorders/build-install-link.mjs --label storeA --token-in query
```

This is a reinstall on the same store, so it also feeds step 3. Write down whether the dashboard now lists one app or two, and one set of webhooks or two.

### 2. Install: deny (AC 1)

```powershell
node scripts/spikes/easyorders/build-install-link.mjs --label denied
```

You: open the link and decline, then open it again and close the tab without choosing.

Write down: is there a deny button at all, does anything reach `/cb` or `/done`, and with what parameters.

### 3. Callback replay and reinstall (AC 1, 2, 6)

Local only, no EasyOrders call. Replay a callback with a made-up key against each token state:

```powershell
node scripts/spikes/easyorders/build-install-link.mjs --list
curl.exe -s -o NUL -w "%{http_code}`n" -X POST "http://localhost:3199/cb/not-a-token" -H "Content-Type: application/json" -d '{\"api_key\":\"forged\",\"store_id\":\"forged\"}'
```

This proves only what the capture server does. The provider facts to record are from the reinstall in step 1:

- Did the second install return a different `api_key` fingerprint?
- Does the first key still work? (`api-probe.mjs get-order` with the old key, once step 5 gives an order.)
- Do webhooks still arrive on the first install's URL? In the capture console they show as `token=revoked(storeA@1)`.

### 4. Webhook secret delivery (AC 7)

You, in the seller dashboard under **Public API → Webhooks**, after step 1:

- Are the webhooks created by the install link listed there?
- Does each one show a secret? Is it one secret per webhook, per app, or per store? Can it be shown again later, or only once?
- Can the seller regenerate it, and does that need a new install?

If a secret is visible, set `EO_WEBHOOK_SECRET` and restart the capture server; from then on the console prints `secret=match` or `secret=mismatch`.

Then install without the status webhook and compare:

```powershell
node scripts/spikes/easyorders/build-install-link.mjs --label storeA --no-status-webhook
```

Write down: whether order webhooks carry a `secret` header at all (`secretHeader.state`), whether its fingerprint is the same for the orders and status webhooks, and whether it changed across reinstalls.

### 5. Order created (AC 2, 3, 4) — live

You: place a COD order on the test storefront with your own phone number. Set `$env:EO_ORDER_ID` to the `id` in the captured payload.

Write down:

- Capture `kind: "orders"`: `headerNames`, `secretHeader`, body keys. Any currency, country, delivery ID or event-type field?
- The phone exactly as the customer typed it versus as delivered (local `01…`, `+20…`, spaces?).
- Time from placing the order to the webhook.

Then read it back and look for store-level currency and country:

```powershell
node scripts/spikes/easyorders/api-probe.mjs get-order
node scripts/spikes/easyorders/api-probe.mjs discover
```

`discover` tries seven undocumented paths and prints any field whose name mentions currency, country, phone or locale. All 404 is a valid finding. Also write down what the dashboard shows as the store's currency and country, and whether a store can sell in more than one.

Forged requests, local only:

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" -X POST "http://localhost:3199/orders/not-a-token" -H "Content-Type: application/json" -H "secret: wrong" -d '{\"id\":\"forged\"}'
```

### 6. Duplicates, retries and ordering (AC 3) — live

Queue failing responses, then place one more test order:

```powershell
curl.exe -s -X POST "http://localhost:3199/_mode?next=500,500,200"
```

Leave the capture server running for at least an hour afterwards. Write down how many deliveries arrive for that order, their spacing, and whether `bodySha256` and the headers are identical across attempts.

Repeat with a slow response (35 s by default) to find the provider's timeout:

```powershell
curl.exe -s -X POST "http://localhost:3199/_mode?next=slow"
```

Ordering: place an order and change its status in the dashboard within a few seconds. Write down which webhook arrived first.

### 7. Status webhook and tenant resolution (AC 6) — live

You: change the status of the test order in the dashboard (`pending → confirmed`).

Write down:

- Capture `kind: "status"`: body keys. Confirm there is no `store_id`, no delivery ID and no timestamp.
- Whether the token survived in the URL (`token=valid(storeA)`).
- Whether the status webhook has a `secret` header and whether its fingerprint equals the order webhook's.

Revoked token: revoke the label, then change the status again.

```powershell
node scripts/spikes/easyorders/build-install-link.mjs --revoke storeA
```

The console shows `token=revoked` and the server answers 401. Write down whether EasyOrders retries a 401 and whether it ever disables the webhook.

Another tenant's token needs a second store: install there with `--label storeB`, then check that every webhook for store B's orders arrives on store B's token only. Without a second store this item stays UNKNOWN.

### 8. API key validity and ownership (AC 2) — live

```powershell
node scripts/spikes/easyorders/api-probe.mjs get-order
node scripts/spikes/easyorders/api-probe.mjs bad-key
node scripts/spikes/easyorders/api-probe.mjs no-key
node scripts/spikes/easyorders/api-probe.mjs get-order 00000000-0000-4000-8000-000000000000 --note "unknown order"
```

With a second store: `get-order <order id of store A> --key 2`. A 200 there would be a cross-tenant read and must be reported to EasyOrders.

Then you revoke or regenerate the key in the dashboard and run `get-order` again. Write down the status and body for each case, and how long after revocation the key stops working.

Also install once with `--permissions orders:read` and run `set-status confirmed`: the expected result is a permission error. Write down what it actually is.

### 9. Currency and phone country (AC 4)

Covered by the observations in step 5. If you have access to a store in another country, repeat step 5 there and compare `total_cost`, the phone format and `government`.

### 10. Status transitions and side effects (AC 4, 5) — live

Use a fresh test order for each row. After each call, check the test phone and inbox, the order page, the product stock, and any shipping-company integration.

```powershell
node scripts/spikes/easyorders/api-probe.mjs set-status confirmed --note "pending->confirmed"
node scripts/spikes/easyorders/api-probe.mjs set-status canceled  --note "pending->canceled"
node scripts/spikes/easyorders/api-probe.mjs set-status canceled  --note "confirmed->canceled"
node scripts/spikes/easyorders/api-probe.mjs set-status confirmed --note "canceled->confirmed"
node scripts/spikes/easyorders/api-probe.mjs set-status confirmed --note "confirmed->confirmed (repeat)"
node scripts/spikes/easyorders/api-probe.mjs set-status not_a_status --note "invalid status"
```

Write down for each row:

- Response status and body.
- Whether the customer received an SMS, WhatsApp message or email from EasyOrders.
- Whether stock changed, whether a shipment was created or canceled, whether anything was refunded.
- Whether a status webhook came back to the capture server for a change Akeed itself made (the feedback loop US-06-04 must not react to), and whether a repeat of the same status sends one.

### 11. Rate limit (AC 8) — live

```powershell
node scripts/spikes/easyorders/rate-burst.mjs --count 60 --interval-ms 500
```

Wait two minutes. If a second key exists (a second dashboard key on the same store, or a second store), set `EO_API_KEY_2` and run:

```powershell
node scripts/spikes/easyorders/rate-burst.mjs --count 100 --interval-ms 300 --keys both
```

Tell me what the two keys have in common (same store or different stores). If you can, run the single-key burst once more from another network to see whether the limit follows the IP.

The script records the request at which the first 429 appeared, its headers and body, and how long the key stayed limited. Also write down whether webhooks kept arriving while the key was limited.

### 12. Uninstall and cleanup (AC 6, 8) — live

You: remove the app (or its API key and webhooks) in the dashboard. Change an order's status afterwards.

Write down: whether webhooks stop, whether the key is rejected, and whether Akeed is notified in any way.

Then test webhook deletion by URL with both header styles; the docs show `Authorization: Bearer` on this one endpoint and `Api-Key` everywhere else. Run this on a webhook that is still registered:

```powershell
node scripts/spikes/easyorders/api-probe.mjs delete-webhook "<the full webhook URL>" --auth api-key
node scripts/spikes/easyorders/api-probe.mjs delete-webhook "<the full webhook URL>" --auth bearer
```

The full URL contains a spike token; it is not written to the evidence. `build-install-link.mjs` prints it inside the install link.

## What to hand back

- `.tmp/spikes/easyorders/capture.jsonl`, `api.jsonl` and `rate.jsonl`. Tell me they are ready and I will read them from disk. Do not send `tokens.json`.
- Your written notes for the "Write down" items, with the date of each session.
- Which store(s) were used, described without identifiers ("test store A, Egypt, EGP").
- Anything EasyOrders support told you about rate limits, retries or revocation, with the date.

## Making fixtures

```powershell
node scripts/spikes/easyorders/sanitize-fixture.mjs --seq <n> --out test/fixtures/easyorders/order-created.json
```

The script prints every string it left unchanged. Read that list before committing.
