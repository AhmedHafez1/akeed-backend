# US-05-06 — Server API pilot checklist

- **Story:** [US-05-06 — Prove cross-channel equivalence, isolation and recovery](US-05-06-api-security-and-recovery-release-gate.md)
- **Status:** Closed 2026-10-02. The product owner tested the API and reports it working as expected. The step-by-step observations (status, code and correlation ID per step, and the section 3 counts) were not handed back, so the tables below are blank; the result on record is that report. Every step touches a deployed environment, real credentials or Meta's platform, so the product owner ran it. Claude Code didn't.
- **Scope:** an authorized pilot with **synthetic orders only**, on one or two Akeed-owned Standalone stores. No merchant's customers are contacted.
- **Data rule:** record store codes (`S1`, `S2`), key prefixes (`ak_live_xxxxxxxx`) and correlation IDs. Never record a full API key, an organization UUID in a shared copy, a phone number or a customer name. Keep the store-code → UUID key outside this repository.

**EXTERNAL PLATFORM DEPENDENCY:** the pilot sends real WhatsApp messages through Meta with the existing Akeed sender. There is no test mode: every accepted cash-on-delivery order sends one message and spends one credit. Use only phone numbers of handsets the team holds.

---

## 1. Before the pilot (once)

| # | Step | Owner | Done (date) |
| --- | --- | --- | --- |
| 1.1 | Record the backend and frontend commits being deployed. They must be the commits the release gate ran on (`.tmp/release-gates/e05-*.json` names them); rerun `npm run test:gate:e05` if they differ. | PO | |
| 1.2 | Deploy. Confirm migration `0046_integration_api_keys` is applied (the app applies it at boot) and the app started without a configuration error. | PO | |
| 1.3 | Confirm the API runs as **one backend instance**. The rate-limit counters are in memory; a second instance would give each its own budget. | PO | |
| 1.4 | Set `WEBHOOK_RECONCILIATION_ENABLED=true` (it is `false` in `.env.example`). The recovery sweep is what sends an order whose request answered `503 API_ORDER_DISPATCH_FAILED` when the client never retries. | PO | |
| 1.5 | Leave `ORDER_API_RATE_LIMIT_PER_INTEGRATION` (60), `ORDER_API_RATE_LIMIT_GLOBAL` (300), `ORDER_API_RATE_LIMIT_PRE_AUTH_PER_IP` (600) and `ORDER_API_MAX_BODY_BYTES` (32768) at their defaults unless a value is recorded here. | PO | |
| 1.6 | Open Settings → API keys on the deployed frontend and check that the address it shows is the public API host (it prints `NEXT_PUBLIC_API_URL`). | PO | |
| 1.7 | Choose the pilot stores: `S1` (and `S2` for the isolation check). Each is an Akeed-owned Standalone organization with onboarding completed, automatic verification on, and at least 20 credits. | PO | |
| 1.8 | Choose the handsets: at least two WhatsApp numbers the team holds. Every `customerPhone` in the pilot is one of them, in international format (`+20…`). | PO | |
| 1.9 | As owner of `S1`, create a key named `pilot`. Copy it once into the team's secret store. Do the same for `S2`. Record the two prefixes. | PO | |
| 1.10 | Decide the open items in section 7 that are marked **before the pilot**. | PO | |

---

## 2. Pilot script (synthetic orders)

Set the two values in the shell that sends the requests. They are never written to this file.

```bash
export AKEED_API_URL='https://<public API host>'
export AKEED_API_KEY='<the S1 key>'
```

Every request has this form. Change the `Idempotency-Key` and the body as each step says.

```bash
curl -sS -i -X POST "$AKEED_API_URL/api/v1/orders" \
  -H "Authorization: Bearer $AKEED_API_KEY" \
  -H "Idempotency-Key: pilot-0001" \
  -H "Content-Type: application/json" \
  -d '{"externalOrderId":"PILOT-0001","customerName":"Pilot One","customerPhone":"<handset 1>","totalPrice":"150.00","currency":"EGP","paymentMethod":"cod"}'
```

Record the status, the `code` (for errors) and the `X-Correlation-Id` of every step.

| # | Step | Expected | Observed |
| --- | --- | --- | --- |
| 2.1 | Send `PILOT-0001` with key `pilot-0001`. | `202`, `status: accepted`, `duplicate: false`, an `orderId`. One WhatsApp message on handset 1. The order appears in Verifications as sent. | |
| 2.2 | Send 2.1 again, unchanged. | `202`, the same `orderId`, `duplicate: true`, now with a `verificationId`. No second message. | |
| 2.3 | Send 2.1 with `totalPrice` `999.00`. | `409 API_ORDER_IDEMPOTENCY_CONFLICT`. No message. The order is unchanged. | |
| 2.4 | Send the 2.1 body with a new key `pilot-0001-b`. | `202`, the same `orderId`, `duplicate: true`. No message. | |
| 2.5 | Send the 2.1 body with `city` added and a new key. | `409 API_ORDER_EXTERNAL_ID_CONFLICT`. No message. | |
| 2.6 | Tap **Confirm** on handset 1. | Verifications shows the order as confirmed within a minute. Credits used: 1. | |
| 2.7 | Send `PILOT-0002` to handset 2, then tap **Cancel**. | `202`; one message; the order shows as canceled. | |
| 2.8 | Send `PILOT-0003` to handset 1 and do not reply. | `202`; one message; a reminder after the store's follow-up delay; "no reply" after the no-reply delay. | |
| 2.9 | Send `PILOT-0004` with `paymentMethod` `Credit Card`. | `202`, no `verificationId` on a replay, **no** message, no credit used. The order is visible and not sent. | |
| 2.10 | Send an order with `customerPhone` `01001234567`. | `400 API_VALIDATION_FAILED` with `fieldErrors.customerPhone`. Nothing stored. | |
| 2.11 | Send an order with an extra field `"discount":"10"`. | `400 API_VALIDATION_FAILED` with `fieldErrors.discount`. | |
| 2.12 | Send a request without the `Idempotency-Key` header. | `400 API_VALIDATION_FAILED`. | |
| 2.13 | Send a body larger than 32 KB (pad `notes`). | `413 API_PAYLOAD_TOO_LARGE`. | |
| 2.14 | Send 61 requests within a minute, each with an invalid body (2.10), so that none creates an order. | The first 60 answer `400`; the 61st answers `429 API_RATE_LIMITED` with `Retry-After` in seconds. After that many seconds a valid request answers `202`. | |
| 2.15 | **Isolation.** With the `S2` key, send the 2.1 body and key (`pilot-0001`). | `202`, `duplicate: false`, a **different** `orderId`. The order is in S2's Verifications and not in S1's; S1's list is unchanged. | |
| 2.16 | Signed in as a member of `S2`, open Settings → API keys. | Only S2's key is listed. | |
| 2.17 | **Rotation.** In S1 create a key `pilot-2`. Send 2.1 (key `pilot-0001`) with the new API key. | `202`, the same `orderId` as 2.1, `duplicate: true`. | |
| 2.18 | **Revocation.** In S1 revoke the key `pilot`. Immediately send a new order with it, then replay 2.1 with it. | Both answer `401 API_KEY_INVALID` at once. Settings shows the key as revoked with its last-used time. | |
| 2.19 | Open S1's Verifications. | Every order from 2.1 to 2.9 is still listed with its outcome. | |
| 2.20 | **File import, then API.** Import a one-row file in S1 (reference `PILOT-0005`, amount `150.00`, payment `cash_on_delivery`, handset 1 in international format) and press **Send**; wait for its message. Then send the same order by API (`pilot-2` key) with exactly those values. | The import sends one message. The API answers `202`, `duplicate: true`, with the imported order's id, and sends **no** second message. A `409 API_ORDER_EXTERNAL_ID_CONFLICT` here means a field was written differently, which is the documented strict comparison, not a fault. | |
| 2.21 | Viewer check: signed in as a viewer of S1, open Settings → API keys. | Keys are listed; there is no create or revoke action. | |
| 2.22 | Look at each screen used above in Arabic and English, light and dark, and at phone width. | Text is translated, laid out right to left in Arabic, and readable in both themes. | |

---

## 3. Reconciliation after the pilot

Run this read-only query against the pilot database for each store and compare it with the steps above. Replace `:org` with the store's organization UUID.

```sql
SELECT
  (SELECT count(*) FROM orders o
     WHERE o.org_id = :org AND o.raw_payload->>'ingestionType' = 'api')            AS api_orders,
  (SELECT count(*) FROM webhook_events e
     WHERE e.org_id = :org AND e.idempotency_key LIKE 'api:%')                      AS api_events,
  (SELECT count(*) FROM webhook_events e
     WHERE e.org_id = :org AND e.idempotency_key LIKE 'api:%'
       AND e.status NOT IN ('completed', 'skipped'))                                AS api_events_not_finished,
  (SELECT count(*) FROM verifications v
     JOIN orders o ON o.id = v.order_id
     WHERE o.org_id = :org AND o.raw_payload->>'ingestionType' = 'api')            AS api_verifications,
  (SELECT count(*) FROM verification_message_dispatches d
     JOIN verifications v ON v.id = d.verification_id
     JOIN orders o ON o.id = v.order_id
     WHERE o.org_id = :org AND o.raw_payload->>'ingestionType' = 'api')            AS api_dispatches,
  (SELECT count(*) FROM credit_reservations r
     JOIN verifications v ON v.id = r.verification_id
     JOIN orders o ON o.id = v.order_id
     WHERE o.org_id = :org AND o.raw_payload->>'ingestionType' = 'api')            AS api_credit_reservations;
```

Expected for `S1` after section 2, when nothing went wrong:

- `api_orders` = `api_events` = 4 (`PILOT-0001` to `PILOT-0004`; the imported `PILOT-0005` belongs to the import).
- `api_events_not_finished` = 0.
- `api_verifications` = 3 (`PILOT-0004` is not cash on delivery).
- `api_dispatches` = 4: one first message for each of the three orders, plus the reminder of `PILOT-0003`.
- `api_credit_reservations` = `api_dispatches` (one reservation per message).
- WhatsApp messages received on the handsets = `api_dispatches`, plus the one message of the imported `PILOT-0005`.

Any other result is a finding. Record it with the correlation IDs and stop the pilot (section 5) before investigating.

---

## 4. Support and recovery

Start from the `X-Correlation-Id` the integrator quotes. It is on every response and in every error body.

| Symptom | What it means | What to do |
| --- | --- | --- |
| Any error with a correlation ID | One log line per request: `action: order-api-request`, with `correlationId`, `resultCode`, `httpStatus`, `integrationId`, `keyPrefix` and, for accepted orders, `orderId`. | Filter the backend logs by `correlationId`. The line never contains the key, the body or customer data. |
| `401 API_KEY_INVALID` | The key is revoked, mistyped, sent in the URL, or not sent as `Authorization: Bearer`. The answer is the same for all four on purpose. | Check Settings → API keys for the prefix and its status. Issue a new key; a revoked key cannot be restored. |
| `400 API_VALIDATION_FAILED` | A field is missing, unknown or invalid; `fieldErrors` names it. | Fix the request. A phone number needs the country code. |
| `409 API_ORDER_IDEMPOTENCY_CONFLICT` | The same `Idempotency-Key` was used with different order data. | Use one key per order. The stored order is unchanged. |
| `409 API_ORDER_EXTERNAL_ID_CONFLICT` | The store already has this `externalOrderId` with different data (possibly from a file import, or the id written differently). | Send the same data, or a new order id. The stored order is unchanged. |
| `409 API_AUTO_VERIFY_DISABLED`, `API_SETUP_INCOMPLETE`, `API_SOURCE_UNAVAILABLE` | The store cannot send right now. Nothing was stored. | Fix the store in Settings, then retry with the same key. |
| `409 INSUFFICIENT_CREDITS` and the other E04.5 credit codes | The store cannot spend a credit. Nothing was stored. | Add credits or resolve the account, then retry with the same key. |
| `429 API_RATE_LIMITED` | Over 60 requests a minute for the store, or the global limit. | Wait `Retry-After` seconds and retry with the same key. The counters reset when the backend restarts. |
| `413 API_PAYLOAD_TOO_LARGE` | The body is over 32 KB. | Shorten it. |
| `503 API_ORDER_ACCEPTANCE_FAILED` | The database did not accept the order. Nothing was stored. | Retry with the same key. If it persists, check database health. |
| `503 API_ORDER_DISPATCH_FAILED` | The order **is** stored; its job did not reach the queue (Redis). | Retry with the same key after a few seconds (a retry inside the first seconds can answer 503 again). With `WEBHOOK_RECONCILIATION_ENABLED=true` the sweep sends it without a retry. Check Redis health. |
| `500 API_INTERNAL_ERROR` | An unexpected failure, including a database outage while the key was being checked. | Retry with the same key. The request line's `errorCode` holds the PostgreSQL code or error class. |
| No answer (timeout, dropped connection) | The order may or may not be stored. | Retry with the same key: the answer is `duplicate: true` if it was. |
| Accepted order, no message after two minutes | The event did not complete. | Run `scripts/diagnose-verification-lifecycle.sql` and `scripts/webhook-dispatch-dry-run.sql` (read-only). `scripts/webhook-dispatch-recover.sql` is a write: review it first. |
| A customer got two messages for one order | Not expected; the gate proves one message per order under retries and concurrent duplicates. | Blocking finding: stop the pilot (section 5) and record both correlation IDs. |
| An order shows in another store | Not expected; the gate proves tenant isolation. | Blocking finding: stop the pilot (section 5). |

Never ask an integrator for their API key. The prefix (`ak_live_` and eight characters) is enough to identify it.

---

## 5. Rollback: stop new acceptance, keep history

Use these steps in order. Stop at the first one that is enough. None of them deletes or changes an accepted order: every order keeps its normal lifecycle in Verifications (confirm, cancel, no reply, retry), and no data migration is needed.

1. **One store, by the merchant.** An owner or admin revokes the store's keys in Settings → API keys. The next request answers `401 API_KEY_INVALID`; orders already accepted are still processed and shown. (Gate: *AC4 revocation*.)
2. **One store, by staff.** When the merchant cannot be reached, a staff member with database access runs, after review:

   ```sql
   UPDATE integration_api_keys
      SET revoked_at = now(), revoked_by = '<staff user uuid>'
    WHERE org_id = '<organization uuid>' AND revoked_at IS NULL;
   ```

   The guard reads the row on every request, so this takes effect at once and needs no restart.
3. **Every store.** The same statement without the `org_id` condition revokes every active key. There is **no environment kill switch** for the order API (see section 7). Merchants then issue new keys when the API is opened again.
4. **Slow down instead of stopping.** Lower `ORDER_API_RATE_LIMIT_PER_INTEGRATION` and `ORDER_API_RATE_LIMIT_GLOBAL` (minimum 1 a minute each) and restart.
5. **Remove the code.** Redeploy the previous build. `integration_api_keys` stays (the migration is additive) and is unused; API-created orders are ordinary Standalone orders and keep working. To withdraw the guide, remove the two `content/docs/*/server-api.md` pages.

Record every rollback with the date, the reason and the step used.

---

## 6. Blocking rules

Any one of these blocks the release until it is explained and fixed:

1. An order, a key, a usage figure or an error detail of one store is visible to another.
2. One order produces more than one first message, or a replay or a conflict produces any message.
3. A revoked key is accepted.
4. A `202` whose order is missing from Verifications, or the section 3 counts do not reconcile.
5. An API key, a key hash, a phone number or a customer name appears in a log line or an error body.
6. The WhatsApp number's quality rating drops, or the verification template is paused, during the pilot window.

---

## 7. Decisions (closed 2026-10-02)

Closed with the pilot result. D2 and D7 applied to the pilot itself and are closed with it; `WEBHOOK_RECONCILIATION_ENABLED=true` stays a deployment requirement (step 1.4). D1, D3, D4, D5, D6 and D8 are accepted for the current single-instance deployment and listed under *Deferred (post-pilot)* in the [E05 README](README.md#deferred-post-pilot). None blocks the release.

| # | Item | When | Note |
| --- | --- | --- | --- |
| D1 | **No global kill switch.** Stopping the API for everyone is a SQL revoke (5.3) or a redeploy. An `ORDER_API_ENABLED` flag in the edge would be a few lines, owned by US-05-04. | Before widening beyond the pilot | Not built here: it is new behavior, not a defect the gate found. |
| D2 | **No pilot gating.** Once deployed, every Standalone owner sees Settings → API keys and can issue a key. | Before the pilot | Accept it, or gate the tab and `POST /api/integration-keys` by an allow-list as bulk import did (`BULK_IMPORT_PILOT_ORG_IDS`). |
| D3 | **No test mode.** An accepted cash-on-delivery order always sends a real message and spends a credit. | Before real integrators | Product decision recorded in US-05-05. |
| D4 | **Phones need the country code.** The API passes no country to the phone parser; file import uses the store's. | Before real integrators | A small core-neutral change that alters which requests are accepted. |
| D5 | **`trust proxy` is not set.** Behind a proxy the pre-auth limit is one shared bucket for all clients. | Before real integrators | US-05-04 gap. |
| D6 | **In-memory rate-limit counters.** Correct for one instance only. | Before a second instance | Deferred in the E05 README. |
| D7 | **The recovery sweep is off by default** (`WEBHOOK_RECONCILIATION_ENABLED`). | Before the pilot (step 1.4) | Without it, a `503 API_ORDER_DISPATCH_FAILED` order waits for the client's retry. |
| D8 | **Bodies are read before authentication and rate limits.** A request with no key and a bad or oversized body answers `400`/`413` without being counted by any limit (at most 32 KB is read). | Before real integrators | The documented US-05-04 order; changing it is a design decision. |

---

## 8. Hand-off list (for the product owner)

These are the live steps Claude Code did **not** run. They are ticked on the product owner's report of 2026-10-02, not on records in this repository:

- [x] Section 1 on the pilot environment.
- [x] Section 2, steps 2.1 to 2.22, with status, code and correlation ID recorded for each.
- [x] Section 3 for `S1` and `S2`.
- [x] The decisions in section 7 (closed as stated there).
- [x] The authenticated browser look at Settings → API keys, Verifications and the two guide pages (`/en/docs/server-api`, `/ar/docs/server-api`) in both locales and both themes (step 2.22).
- [x] The go/no-go decision: go. The story and the epic are Done.
