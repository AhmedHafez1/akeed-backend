# US-06-01 — EasyOrders contract record

- **Story:** [US-06-01 — Validate EasyOrders authorization and event semantics](../US-06-01-easyorders-integration-validation.md)
- **Record date:** 2026-10-03
- **State:** Interim. Written from the public docs plus one test run on an inactive store. A second run on an active store is owed before any live traffic (see [Go-live verification](#go-live-verification-owed)).
- **Verdict in one line:** US-06-02 and US-06-03 may be built, disabled. Remote status writes and live onboarding stay blocked.

This record is the only source of truth for EasyOrders behavior in E06. Where it says UNKNOWN, do not fill the gap from the public docs or by assumption: follow the worst-case rule written next to it, or stop and ask.

## Sources

| Source                                                                                         | Version              | Read or run |
| ---------------------------------------------------------------------------------------------- | -------------------- | ----------- |
| [Authorized app link](https://public-api-docs.easy-orders.net/docs/create_authorized_app_link) | none published       | 2026-10-03  |
| [Webhooks](https://public-api-docs.easy-orders.net/docs/webhooks)                              | none published       | 2026-10-03  |
| [Authentication](https://public-api-docs.easy-orders.net/docs/authentication)                  | none published       | 2026-10-03  |
| [Update order status](https://public-api-docs.easy-orders.net/docs/update-order-status)        | none published       | 2026-10-03  |
| [Rate limit](https://public-api-docs.easy-orders.net/docs/rate-limit)                          | none published       | 2026-10-03  |
| [Get order by ID](https://public-api-docs.easy-orders.net/docs/get-order-by-id)                | none published       | 2026-10-03  |
| Seller dashboard `app.easy-orders.net`                                                         | v2.4.22              | 2026-10-03  |
| Test run with the [spike kit](../../../../scripts/spikes/easyorders/README.md)                 | kit commit `3d1f14a` | 2026-10-03  |

**Test store:** one store ("test store A"), Egypt, created for this spike, **inactive** (wallet not topped up). No second store. Evidence files stay local in `.tmp/spikes/easyorders/` and are not committed; credentials, webhook secrets and URL tokens appear in them only as fingerprints.

## How to read the labels

- **VERIFIED** — observed in the 2026-10-03 run (capture log, API probe log, dashboard, browser network panel).
- **DOCUMENTED** — stated in the public docs, not observed.
- **UNKNOWN** — neither documented nor observed.

## Evidence bar (product-owner decision, 2026-10-03)

The story says any UNKNOWN on authenticity, tenant resolution, secret handling or status behavior blocks US-06-02 through release. The product owner relaxed that on 2026-10-03 to **build on docs, gate go-live**:

- Code may be built against DOCUMENTED behavior.
- Every UNKNOWN gets a worst-case rule here, and the code follows that rule.
- Nothing is enabled for a real merchant until the owed run turns the blocking UNKNOWNs into VERIFIED. A finding that contradicts this record reopens the affected story.

The docs were already wrong once (who sends the install callback, section 1), which is why DOCUMENTED is not treated as proof.

## 1. Installation parameters, callback and correlation (AC 1)

| Finding                                                                                                                                                                                                                                                                                                                                            | Label      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Install link: `https://app.easy-orders.net/#/install-app` with `app_name`, `app_description`, `app_icon`, `permissions`, `callback_url`, `orders_webhook`, `redirect_url` (required) and `order_status_webhook` (optional).                                                                                                                        | DOCUMENTED |
| The consent page shows the app name, description and requested permissions, a notice that the webhook can see new orders and can be deleted later, and Accept and Cancel buttons. It does not show the webhook or callback URLs.                                                                                                                   | VERIFIED   |
| `permissions=orders:read,orders:update` is accepted and shown as "Read Orders" and "Update Orders".                                                                                                                                                                                                                                                | VERIFIED   |
| There is no `state`, nonce or other correlation parameter.                                                                                                                                                                                                                                                                                         | DOCUMENTED |
| On Accept, the seller's **browser** creates the webhooks (one request each, 201) and an API key (201), then calls `callback_url` itself as a cross-origin request from `https://app.easy-orders.net`, preceded by a CORS preflight. EasyOrders' servers do not call the callback. The docs say "sends a POST request" without saying who sends it. | VERIFIED   |
| Callback body is `{ "api_key", "store_id" }`.                                                                                                                                                                                                                                                                                                      | DOCUMENTED |
| Callback headers, and whether anything else is in the body. The run's capture server did not answer the preflight, so the browser never sent the POST.                                                                                                                                                                                             | UNKNOWN    |
| Install is not atomic. Every Accept left a new API key and new webhooks on the store even though the callback failed.                                                                                                                                                                                                                              | VERIFIED   |
| A second install on the same store adds webhooks; it does not replace the earlier ones. The same URL was registered twice, with two different secrets.                                                                                                                                                                                             | VERIFIED   |
| `callback_url` and webhook URLs keep a path segment and a query string exactly as given.                                                                                                                                                                                                                                                           | VERIFIED   |
| Redirect to `redirect_url`: when it happens and with which parameters. It did not happen after a failed callback.                                                                                                                                                                                                                                  | UNKNOWN    |
| Cancel and closed-tab behavior.                                                                                                                                                                                                                                                                                                                    | UNKNOWN    |

**Correlation method (approved).** Because the link has no `state`, the install context rides in Akeed's own `callback_url`:

- When an owner or admin starts the install, Akeed creates a pending-install row bound to their organization and user, with a random token of at least 256 bits, stored hashed, expiring in 15 minutes.
- The token goes in the **path** of `callback_url`. Path is preferred over query because query strings are logged more widely.
- The callback endpoint is public and must answer the CORS preflight for the origin `https://app.easy-orders.net` only. The token is the only thing that binds the request to a tenant.
- The token is consumed on the first callback that passes verification (section 2). A second use, an expired token, or an unknown token is rejected without changing any stored credential.
- The API key passes through the seller's browser. The callback must use HTTPS, must never echo the key back, and the key must not appear in logs.

**Consequences for US-06-02:**

- A failed or abandoned install leaves an orphan key and webhooks at EasyOrders. Akeed cannot clean them up without a working key; connection guidance must tell the seller to delete them.
- A retry is a new install with a new token and produces a new key and new webhooks.

## 2. Credentials, store ownership and webhook authenticity (AC 2)

| Finding                                                                                                                                                                                | Label                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| API calls use the header `Api-Key: <key>` against `https://api.easy-orders.net/api/v1/external-apps/`.                                                                                 | DOCUMENTED                                   |
| An inactive store answers authenticated calls with `400` and `{"message":"Store not active or has over due"}`. Seen on `GET orders/:id`, `PATCH orders/:id/status` and `GET products`. | VERIFIED                                     |
| Responses carry no rate-limit or request-ID headers.                                                                                                                                   | VERIFIED (on the 400 and 404 responses only) |
| There is no store, settings or countries endpoint: `store`, `stores`, `settings`, `shipping_areas`, `countries` and `orders?limit=1` returned `404` with an empty body.                | VERIFIED                                     |
| Response to a wrong, missing or revoked key, and how fast revocation takes effect.                                                                                                     | UNKNOWN                                      |
| Whether a key can read another store's order.                                                                                                                                          | UNKNOWN                                      |
| Which call proves that a key belongs to the `store_id` in the callback. No endpoint returns the key's store; an order fetched by ID carries `store_id`.                                | UNKNOWN                                      |
| Webhooks carry a `secret` header holding a static value generated when the webhook is created.                                                                                         | DOCUMENTED                                   |
| The `secret` header on a real delivery.                                                                                                                                                | UNKNOWN (no delivery was received)           |

**The `secret` header is a shared secret, not a signature.** It is the same on every delivery, it is not derived from the body, and it proves nothing about body integrity or freshness. Do not call it an HMAC, do not build replay protection on it, and compare it with a timing-safe comparison after a length check.

**Rules:**

- **Callback verification.** Never trust the callback body. Before storing anything, call the API server-side with the received key. A success proves the key is live. A `400` with the inactive-store message also proves the key is recognized, and is recorded as a connection-health state ("store inactive"), not as a credential failure.
- **Store ownership.** Until a call that returns the key's own `store_id` is found, the callback's `store_id` is a **claim**. It becomes verified the first time data fetched with the stored key (an order by ID) carries the same `store_id`. Every order webhook's `store_id` must equal the stored one or the event is rejected. One EasyOrders store maps to at most one Akeed integration, and an unverified claim must not hold that slot against the real owner.
- **Webhook authenticity** needs both factors: the per-install URL token (section 6) and the matching `secret` header (section 7). Either one missing or wrong is `401`, and nothing is queued.
- **Credential failures.** Until the real responses are seen, treat `401` and `403` as permanent credential or permission failures that need merchant action, and the inactive-store `400` as a retryable health state with slow backoff. Do not retry either in a tight loop.

Live onboarding stays blocked until the callback payload and a real `secret` header have been observed.

## 3. Fixtures, delivery ID, duplicates, retries and ordering (AC 3)

| Finding                                                                                                                                                                                                                                             | Label                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Order-created payload: the order object itself (`id`, `store_id`, `created_at`, `updated_at`, `cost`, `shipping_cost`, `total_cost`, `status`, `full_name`, `phone`, `government`, `address`, `payment_method`, `cart_items`). No event-type field. | DOCUMENTED                                  |
| Status payload: `event_type: "order-status-update"`, `order_id`, `old_status`, `new_status`, `payment_ref_id`.                                                                                                                                      | DOCUMENTED                                  |
| Neither payload has a delivery ID, an event ID or a sent-at timestamp.                                                                                                                                                                              | DOCUMENTED                                  |
| Retry policy, timeout, expected response code, duplicate delivery, ordering between the two webhooks.                                                                                                                                               | UNKNOWN                                     |
| No order webhook arrived for two orders created from the dashboard on the inactive store. The cause is not established: inactive store, dashboard-created order, or both.                                                                           | VERIFIED (the absence), UNKNOWN (the cause) |
| The same URL can be registered more than once, so one event can legitimately arrive more than once, each with a different `secret`.                                                                                                                 | VERIFIED (registration), UNKNOWN (delivery) |

**Fixtures.** [`test/fixtures/easyorders/`](../../../../test/fixtures/easyorders/README.md) holds an order-created and a status fixture. They are built from the documented shapes with synthetic values and are marked `documented, not captured`. AC 3 asks for captured fixtures; that part is not met and is owed.

**Worst-case rules for US-06-03** (phrased against `webhook_events`, `WebhookJobPayload` and the `WebhookOrderNormalizer` registry):

- **Idempotency key.** With no delivery ID, Akeed derives one. Order created: `integrationId` + order `id`. Status: `integrationId` + `order_id` + `old_status` + `new_status`. The key is source-scoped, as in E05. A legitimate repeat of the same transition collapses into one event; that is accepted.
- **Assume at-least-once and out of order.** A status event may arrive before its order. Processing must be safe to re-run and must not depend on arrival order.
- **Assume no provider retry.** Persist the `webhook_events` row before answering `2xx`, and answer fast. If the row cannot be written, answer `5xx`; a lost event is then recovered only if EasyOrders retries, which is unknown, so the failure must be logged and alertable.
- **Job types.** Order created maps to `WebhookJobType.ORDER_CREATE`. The status webhook maps to `ORDER_UPDATE`, which the processor does not handle yet; adding that handler is US-06-03/04 work.
- **Trusted identity.** `orgId` and `integrationId` on the job come from the URL token, never from the payload. The payload's `store_id` is only checked against the integration.

## 4. Currency, phone country and the meaning of status updates (AC 4)

| Finding                                                                                                                     | Label                                             |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| The order payload has no currency and no country field. Amounts are bare numbers.                                           | DOCUMENTED                                        |
| The order object the dashboard itself loads has no currency or country field either.                                        | VERIFIED                                          |
| No API endpoint exposes store currency or country (section 2).                                                              | VERIFIED                                          |
| The dashboard order list has an "IP Country" column. It is the buyer's IP location, not the store's country or the phone's. | VERIFIED                                          |
| `phone` is delivered in local format, without a country code.                                                               | VERIFIED (dashboard object), DOCUMENTED (webhook) |
| `government` is free text, in the example in Arabic.                                                                        | DOCUMENTED                                        |
| `payment_method: "cod"` marks cash on delivery. Other values are not listed.                                                | DOCUMENTED                                        |
| What `confirmed` and `canceled` mean to EasyOrders and what they trigger.                                                   | UNKNOWN (section 5)                               |

**Authoritative sources (approved):**

- **Currency** is a required setup input chosen by the merchant when connecting, stored on the integration. The normalizer copies it into `NormalizedOrder.currency`. It is never inferred.
- **Phone country** is a required setup input (default dial country), stored on the integration. The normalizer uses it to turn the local number into E.164 for `NormalizedOrder.customerPhone`. A number that does not parse for that country is not eligible; it is not guessed from `government` or IP country.
- **Amount** is `total_cost`, written as decimal text.
- **COD** is `payment_method === "cod"` → `codStatus: 'cod'`. Any other or missing value → `'unknown'` until the value list is observed. The mapping lives in the EasyOrders eligibility strategy (`ORDER_ELIGIBILITY_STRATEGIES`), not in core.

**Setup inputs for onboarding (US-06-02, US-06-05):** store currency, default phone country, and the two webhook secrets (section 7). Consent text must say that Akeed reads new orders and updates order status, and that Akeed's messages come from the Akeed WhatsApp sender.

## 5. Outcome mapping (AC 5)

| Finding                                                                                                                                                                                                                                      | Label      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `PATCH /orders/:order_id/status`, body `{ "status": "<value>" }`, permission `orders:update`.                                                                                                                                                | DOCUMENTED |
| Allowed values: `pending`, `confirmed`, `pending_payment`, `paid`, `paid_failed`, `processing`, `waiting_for_pickup`, `in_delivery`, `delivered`, `canceled`, `returning_from_delivery`, `request_refund`, `refund_in_progress`, `refunded`. | DOCUMENTED |
| The dashboard shows `pending` as "Under Review".                                                                                                                                                                                             | VERIFIED   |
| Transition rules, the response body, the error for an invalid transition or status.                                                                                                                                                          | UNKNOWN    |
| Side effects of `confirmed` and `canceled`: customer notifications, stock, shipping-company push, refunds.                                                                                                                                   | UNKNOWN    |
| Whether a status change made through the API fires the status webhook back to Akeed.                                                                                                                                                         | UNKNOWN    |

**Mapping approved for building** (against `CommerceOutcomeAction` in `src/shared/commerce/commerce-outcome.ts`):

| Akeed action                     | EasyOrders effect                                                                          | Adapter capability                              |
| -------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| `customer_confirmation`          | status → `confirmed`                                                                       | yes                                             |
| `customer_cancellation`          | status → `canceled`                                                                        | yes                                             |
| `merchant_no_reply_cancellation` | status → `canceled`, only on an explicit merchant action                                   | yes                                             |
| `automatic_no_reply_tagging`     | none. EasyOrders has no tag concept and automatic no-reply is never a remote cancellation. | no → `unsupported` / `capability_not_supported` |
| `merchant_cancellation_tagging`  | none                                                                                       | no → `unsupported` / `capability_not_supported` |

**Rules for US-06-04:**

- The adapter may be built and unit-tested against this mapping. Remote writes stay **off** for every merchant until the side effects of `confirmed` and `canceled` are observed and the product owner accepts them.
- Only write from `pending`. Read the order first; if its current status is anything else, do not overwrite it and report a permanent, visible failure. This costs one extra request per outcome (section 8).
- Assume the API change does echo back as a status webhook. An incoming status event whose `new_status` equals what Akeed last wrote for that order is recorded and ignored.
- A timeout after sending is ambiguous: read the order back before retrying.

## 6. Tenant resolution for order-status webhooks (AC 6)

| Finding                                                                                                         | Label                          |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| The status payload has no `store_id` and no delivery ID.                                                        | DOCUMENTED                     |
| A token placed in the webhook URL, in the path or in the query, is stored and shown by EasyOrders unchanged.    | VERIFIED                       |
| Webhook URLs, including any token in them, are visible to the seller in the dashboard list and in its export.   | VERIFIED                       |
| Earlier webhooks stay registered after a reinstall.                                                             | VERIFIED                       |
| `DELETE /api/v1/external-apps/webhooks/delete-by-url?url=…` removes a webhook.                                  | DOCUMENTED                     |
| The auth header for that delete call: the page shows `Authorization: Bearer`, every other page shows `Api-Key`. | UNKNOWN                        |
| Whether EasyOrders keeps calling a URL that answers `401`, or disables it.                                      | UNKNOWN                        |
| Whether EasyOrders ever delivers one store's events to another store's URL.                                     | UNKNOWN (needs a second store) |

**Mechanism (approved).** A per-install webhook URL token:

- At least 256 bits from a CSPRNG, base64url, in the path of both `orders_webhook` and `order_status_webhook`. It is a different value from the one-time callback token.
- Stored as a hash on the integration, which is what the lookup uses, so one token resolves to exactly one integration and one organization, or to nothing. **Changed 2026-10-08 (product owner):** it is also kept as `encryptToken` ciphertext, only to rebuild the two webhook addresses for the cleanup below.
- The token decides the tenant. For status webhooks it is the only tenant signal; for order webhooks the payload `store_id` must also match the integration.
- **Rotation.** Reconnect issues a new token and invalidates the old one in the same transaction. Disconnect invalidates it. Because EasyOrders keeps old webhooks registered, deliveries to an old URL will keep arriving and must get `401` with nothing queued.
- **Cleanup.** At disconnect, Akeed tries to delete its webhooks by URL with the key it is giving up; failure is non-fatal and is recorded on the connection (`provider_cleanup`). **Built 2026-10-08** without the live check of the auth header: `Api-Key` is sent first, then `Authorization: Bearer` after a `401` or `403`. Go-live step 12 still has to confirm it. A reconnect follows a disconnect, so it needs no cleanup of its own.
- The token is a credential: never logged, never returned by an API, never in a fixture. The seller can see it in their own dashboard, which is acceptable because it only identifies their own integration and the `secret` header is still required.

**Proof status:**

| Claim                                      | Status                                                                                                                                                                                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cannot be guessed                          | Holds by construction (256-bit random). The spike's capture server rejected unknown tokens with `401`.                                                                                                                                                             |
| Cannot be reused across tenants            | Akeed side: by construction, and owed as a contract test in US-06-03 (tenant A's token with tenant B's `store_id` is rejected; a status event for tenant B's order ID on tenant A's token changes nothing). Provider side: UNKNOWN until a second store is tested. |
| Not accepted after revocation or reconnect | Akeed side: owed as a contract test in US-06-03. The spike's capture server demonstrated the behavior locally (a rotated token answers `401`). Not yet exercised with a real EasyOrders delivery.                                                                  |

A status event must only ever act on an order that already belongs to the integration the token resolved to. An `order_id` that integration does not own is recorded and skipped.

Live status-webhook ingestion stays blocked until a real status delivery has been seen on a token URL.

## 7. Webhook secret delivery (AC 7)

| Finding                                                                                                                                  | Label                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Each webhook gets its own secret when it is created. The orders and the status webhook of one install have different secrets.            | VERIFIED                                |
| Secrets are short: 16 base64 characters, about 80 bits.                                                                                  | VERIFIED                                |
| The seller can see every webhook's secret in **Settings → Public API → Webhooks** at any time, next to its URL, and can export the list. | VERIFIED                                |
| Webhooks created by the install link appear in that list with the app name and description.                                              | VERIFIED                                |
| The callback body contains only `api_key` and `store_id`, so the secret does not reach Akeed during install.                             | DOCUMENTED                              |
| Whether the install page in fact passes the secret to the callback.                                                                      | UNKNOWN (the callback was not captured) |
| Whether a secret can be regenerated without recreating the webhook.                                                                      | UNKNOWN                                 |

**Default until 2026-10-08: the seller copies the secrets.** If the owed run shows the secret arriving in the callback, this step is dropped and the record is updated.

**Default from 2026-10-08 (product owner): Akeed learns the secrets.** The callback is still not known to carry them, and no endpoint returns them, but every delivery carries its webhook's secret in the `secret` header on a URL that holds Akeed's own 256-bit token. While Akeed holds no secret for a webhook, it reads the order the delivery names with the integration's own key (section 2) and keeps the header value of the first delivery that names a real order of the bound store. An order the key cannot see is refused. When EasyOrders gives no verdict the delivery is accepted, nothing is kept, and the order is read back in the worker before it becomes an order. From then on the secret is required as before. The bullets below describe the fallback: the seller can still paste both secrets, and can reset them to be learned again.

- **Setup step.** After a successful callback the integration is in the state "awaiting webhook secrets". The connection screen shows the two webhook URLs' last characters so the seller can find the right rows, and asks for the secret of the orders webhook and the secret of the status webhook, copied from Settings → Public API → Webhooks.
- **Storage.** Both secrets are encrypted at rest with the existing `encryptToken` utility and are write-only: never returned, never logged.
- **Missing secret.** Before 2026-10-08: webhooks were rejected with `401` until both were pasted. Now: a missing secret is the learning state above, and it blocks nothing in setup.
- **Wrong secret.** `401`, nothing queued, and a connection-health warning counting rejected deliveries, so a mistyped secret is visible rather than silent.
- **Duplicate registrations.** If the seller has the same URL registered twice, one of the two deliveries will carry a secret Akeed does not hold and will be rejected. Guidance for US-06-05: keep exactly one orders and one status webhook for Akeed and delete the rest.

## 8. Rate-limit budget (AC 8)

| Finding                                                                                                                         | Label      |
| ------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 40 requests per minute; exceeding it returns `429`; "wait for the next minute". Higher limits by request to EasyOrders support. | DOCUMENTED |
| What the limit applies to: API key, store, app or IP.                                                                           | UNKNOWN    |
| The `429` body and any `Retry-After` or rate headers. Normal responses carried none.                                            | UNKNOWN    |
| Whether the window is fixed (clock minute) or sliding.                                                                          | UNKNOWN    |
| Whether incoming webhooks are affected while a key is limited.                                                                  | UNKNOWN    |

The burst test could not run on an inactive store.

**Worst-case budget and rules:**

- Treat the limit as shared by everything that touches one store. Akeed spends at most **30 requests per minute per integration**, leaving headroom for the merchant's other tools.
- Limit per integration, never globally, so one busy merchant cannot starve another. If the owed run shows the limit is per IP, this must be redesigned before more than one merchant is live.
- **Priority.** Outcome status updates (US-06-04) go before order lookups (US-06-03).
- **No lookup on the webhook path.** The order webhook already carries the order. US-06-03 must not fetch each order on receipt; lookups are for reconciliation and the pre-write status check only.
- **Cost per outcome:** two requests (read current status, then write), three when a timeout forces a read-back. 30 per minute therefore covers about 10 to 15 outcomes per minute per store.
- **On `429`:** return `retryable_failure` from the adapter. Honor `Retry-After` if present; otherwise wait until the next clock minute plus random jitter of up to 10 seconds. Pause that integration's other EasyOrders calls for the same period.
- **Bounded retries.** Use the existing queue backoff with a fixed attempt limit. After the last attempt the outcome stays locally recorded with a visible "sync failed" state and a manual retry. Local customer intent is never lost or rolled back.
- `401`, `403` and the inactive-store `400` are not rate problems and do not use this path.

## Supported, unsupported, unknown

| Area                     | Supported (build on it)                                                            | Unsupported                                                  | Unknown (worst-case rule applies)                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Install                  | Install link with `orders:read,orders:update`; tenant token in our URL paths       | `state` parameter; server-to-server callback; atomic install | Callback headers and extra fields; redirect and cancel behavior                                   |
| Credentials              | `Api-Key` header; inactive-store `400` as a health state                           | A store or account endpoint                                  | Invalid and revoked key responses; cross-store read; proof of `store_id` for a key                |
| Webhook authenticity     | URL token plus static `secret` header                                              | Payload HMAC; replay protection from the provider            | `secret` on a real delivery                                                                       |
| Delivery                 | Derived idempotency keys                                                           | Delivery ID; event timestamp                                 | Retries, timeout, duplicates, ordering; whether inactive stores or dashboard orders fire webhooks |
| Order data               | `total_cost`, `phone` (local), `payment_method`, `store_id`                        | Currency and country in payload or API                       | Other `payment_method` values                                                                     |
| Outcomes                 | Confirm → `confirmed`; customer and merchant cancel → `canceled` (writes disabled) | Automatic no-reply as remote cancel; tagging                 | Transition rules; side effects; echo webhook                                                      |
| Status tenant resolution | Per-install URL token, rotated on reconnect                                        | `store_id` in the status payload                             | Provider cross-tenant behavior; delete-by-URL auth; behavior on `401`                             |
| Webhook secret           | Seller copies two secrets from the dashboard                                       | Secret in the documented callback                            | Secret in the real callback; regeneration                                                         |
| Rate limit               | 30/min per integration, `429` → bounded retry                                      | —                                                            | Scope, window, headers, body                                                                      |

## Verdict

Under the strict rule in the story, US-06-02 through US-06-06 would be **blocked**: authenticity, status behavior and part of secret handling are still UNKNOWN. Under the evidence bar the product owner set on 2026-10-03:

| Story                          | Verdict                                                                                                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| US-06-02 Connect               | **Unblocked to build.** No real merchant may connect until the callback payload is observed.                                                                            |
| US-06-03 Webhook ingestion     | **Unblocked to build**, ingestion disabled by default. Blocked from live traffic until a real order and a real status delivery are observed with their `secret` header. |
| US-06-04 Outcome sync          | **Unblocked to build**, remote writes off. Blocked from enabling until status side effects and the echo behavior are observed and accepted.                             |
| US-06-05 Onboarding and health | Can follow, using the setup inputs and failure behavior in sections 4 and 7. Guidance text is provisional until secret delivery is settled.                             |
| US-06-06 Pilot gate            | **Blocked** until the go-live verification below is complete and this record has no blocking UNKNOWN.                                                                   |

US-06-01 itself is **not Done**: AC 3 (captured fixtures) and most of the test requirements are unmet.

## Go-live verification (owed)

Needs an **active** store; a second store for the last two rows. Step numbers refer to the [spike test plan](../../../../scripts/spikes/easyorders/README.md).

| Closes           | Step                | What must be observed                                                                                                 |
| ---------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Sections 1, 2, 7 | 1, 4                | The callback POST: headers, body fields, whether a webhook secret is included; redirect behavior; cancel behavior     |
| Sections 2, 3    | 5                   | A real order webhook: headers, `secret`, full payload; a captured fixture; storefront versus dashboard-created orders |
| Section 3        | 6                   | Retries after `5xx` and timeout; duplicates; ordering                                                                 |
| Section 6        | 7                   | A real status webhook on a token URL; behavior after the token is rotated                                             |
| Section 2        | 8                   | Wrong, missing and revoked key responses; the call that proves a key's store                                          |
| Section 5        | 10                  | Transitions from `pending`; customer notifications, stock, shipping and refund effects; echo webhook                  |
| Section 8        | 11                  | First `429`, its headers and body, recovery time                                                                      |
| Section 6        | 12                  | Uninstall behavior; delete-by-URL with `Api-Key` and with `Bearer`                                                    |
| Sections 2, 6    | 7, 8 (second store) | No cross-store read with a key; no cross-store webhook delivery                                                       |
| Section 8        | 11 (second key)     | Whether two keys share one limit                                                                                      |

## Doc discrepancies to raise with EasyOrders

- The authorized-app page implies EasyOrders sends the callback. It is sent by the seller's browser and needs CORS on the receiving endpoint.
- The webhook-delete example uses `Authorization: Bearer`; every other page uses `Api-Key`.
- Nothing is published about webhook retries, timeouts, the scope of the rate limit, or the effects of status changes. These are the questions to put to support (`info@easy-orders.net` is the contact given on the rate-limit page).
