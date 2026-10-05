# US-07-01 — WooCommerce contract record

- **Story:** [US-07-01 — WooCommerce integration contract and implementation plan](../US-07-01-woocommerce-integration-contract-and-implementation-plan.md)
- **Record date:** 2026-10-04
- **Baseline:** `akeed-backend` `develop` at `f144b54`
- **State:** Written from the official WooCommerce documentation. No request was sent to any store and no test store exists. The VERIFIED column is empty until the US-07-06 live run.
- **Verdict in one line:** US-07-02 to US-07-06 are unblocked to build, each behind its switch. Nothing is enabled for a real merchant before the US-07-06 gate.

This record is the only source of truth for WooCommerce behavior in E07. Where it says UNKNOWN, do not fill the gap from memory of WooCommerce's source code or by assumption: follow the worst-case rule written next to it, or stop and ask.

## Sources

Every page was read on 2026-10-04. None of them publishes a version number.

| Ref | Source                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | [Developer docs — REST authentication](https://developer.woocommerce.com/docs/apis/rest-api/authentication)                                                               |
| S2  | [Developer docs — Webhooks (REST v3 reference)](https://developer.woocommerce.com/docs/apis/rest-api/v3/webhooks/)                                                        |
| S3  | [Developer docs — Working with webhooks](https://developer.woocommerce.com/docs/working-with-webhooks-in-woocommerce/)                                                    |
| S4  | [Developer docs — REST API introduction](https://developer.woocommerce.com/docs/apis/rest-api/)                                                                           |
| S5  | [Developer docs — Orders (REST v3 reference)](https://developer.woocommerce.com/docs/apis/rest-api/v3/orders/)                                                            |
| S6  | [Developer docs — Order notes (REST v3 reference)](https://developer.woocommerce.com/docs/apis/rest-api/v3/order-notes/)                                                  |
| S7  | [Developer docs — System status (REST v3 reference)](https://developer.woocommerce.com/docs/apis/rest-api/v3/system-status/)                                              |
| S8  | [Developer docs — Payment gateways (REST v3 reference)](https://developer.woocommerce.com/docs/apis/rest-api/v3/payment-gateways/)                                        |
| S9  | [Merchant docs — Webhooks](https://woocommerce.com/document/webhooks/)                                                                                                    |
| S10 | [Merchant docs — Order statuses](https://woocommerce.com/document/managing-orders/order-statuses/)                                                                        |
| S11 | [Merchant docs — Cash on Delivery](https://woocommerce.com/document/cash-on-delivery/)                                                                                    |
| S12 | [WooCommerce issue #37958](https://github.com/woocommerce/woocommerce/issues/37958), state read from the GitHub API: opened 2023-04-24, closed as completed on 2026-09-25 |

S1 to S4 are the four pages the story names. S5 to S8 are the REST reference pages the rules below depend on. S9 to S11 are WooCommerce's own merchant documentation; they are used because the developer pages are silent on what a status means and on the status a COD order gets. S12 is an issue, not documentation: it is cited for the draft-order behavior the story names, and only together with S10.

## How to read the labels

- **DOCUMENTED** — stated on the source in the Source column. Quoted text is copied from the page.
- **DECIDED** — a choice, with who made it and when. "PO" is the product owner; the decision numbers are those in the [epic README](../README.md). "Story" is an acceptance criterion in an E07 story dated 2026-10-04. "Record" is a choice this record makes because something had to be chosen; it stands unless the product owner changes it when reviewing this record.
- **UNKNOWN** — the documentation is silent. Each UNKNOWN has a worst-case rule, and the code follows that rule.
- **VERIFIED** — reserved for US-07-06. A cell is filled only with what was observed on a real store, with the date.

## What differs from EasyOrders

The [E06 record](../../06-easyorders-integration/evidence/US-06-01-contract-record.md) is the model for this one, and the EasyOrders spoke is the model for the code. Copy the structure, not the behavior:

| Topic                | EasyOrders                                      | WooCommerce                                                                                   |
| -------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Provider endpoint    | One fixed API host                              | A different, merchant-supplied host per store. Every call goes through the restricted client. |
| Install callback     | Sent by the seller's browser; needs CORS        | Sent by "the auth endpoint"; no CORS is answered                                              |
| Callback body        | API key and store id                            | Two keys and no store identity                                                                |
| Webhook registration | Done by the install page                        | Done by Akeed through REST after the keys are proven                                          |
| Webhook secret       | Generated by the provider, copied by the seller | Generated by Akeed, never seen by the merchant in Akeed                                       |
| Webhook authenticity | Static shared secret in a header                | HMAC-SHA256 of the raw body                                                                   |
| Currency and country | Not in the payload; setup inputs                | In every order; not setup inputs                                                              |
| Order lookup         | Needed to verify the store                      | Never on the ingest path                                                                      |
| Rate limit           | 40 per minute documented; 30 per minute budget  | None documented; no budget                                                                    |
| Webhook lifecycle    | Cannot be read; deletion unverified             | Read, re-enabled and deleted through REST                                                     |
| Disabling            | Unknown                                         | Documented: disabled after consecutive failed deliveries                                      |
| Status events        | A separate webhook and payload                  | The same order payload on `order.updated`                                                     |

## 1. Authorization and correlation

| #    | Finding                                                                                                                                                                                                                          | Label                         | Source | VERIFIED |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------ | -------- |
| 1.1  | The authorize link is `{store}/wc-auth/v1/authorize` with five mandatory query parameters: `app_name`, `scope`, `user_id`, `return_url`, `callback_url`. "The URL generated must have all query string values encoded."          | DOCUMENTED                    | S1     |          |
| 1.2  | `scope` is "Level of access. Available: read, write and read_write".                                                                                                                                                             | DOCUMENTED                    | S1     |          |
| 1.3  | Akeed asks for `read_write`: it reads orders and webhooks, and it creates webhooks and updates orders.                                                                                                                           | DECIDED (story US-07-02 AC 1) |        |          |
| 1.4  | `callback_url` is the "URL that will receive the generated API key. Note: this URL should be over HTTPS".                                                                                                                        | DOCUMENTED                    | S1     |          |
| 1.5  | "The auth endpoint will send the API Keys in JSON format to the callback_url". The posted JSON has `key_id`, `user_id`, `consumer_key`, `consumer_secret` and `key_permissions`.                                                 | DOCUMENTED                    | S1     |          |
| 1.6  | The posted JSON carries no store URL and no other store identifier.                                                                                                                                                              | DOCUMENTED                    | S1     |          |
| 1.7  | `user_id` is the app's own value: "User ID in your APP. For your internal reference, used when the user is redirected back to your APP. NOT THE USER ID IN WOOCOMMERCE". It comes back in the callback body and on `return_url`. | DOCUMENTED                    | S1     |          |
| 1.8  | The parameter is typed as a string, and every example sends and returns the number `123`. Whether a non-numeric value comes back unchanged, and whether it comes back as a JSON string or number.                                | UNKNOWN                       |        |          |
| 1.9  | "While redirecting the user using return_url, you are also sent success and user_id parameters as query strings." "success sends 0 if the user denied, or 1 if authenticated successfully."                                      | DOCUMENTED                    | S1     |          |
| 1.10 | The keys do not arrive with the redirect: "After being redirected back to your APP, the API keys will be sent back in a separate POST request."                                                                                  | DOCUMENTED                    | S1     |          |
| 1.11 | There is no `state`, nonce or signature parameter, and nothing in the callback authenticates its sender.                                                                                                                         | DOCUMENTED                    | S1     |          |
| 1.12 | Whether the callback is sent by the store's server or by the merchant's browser; its headers and content type.                                                                                                                   | UNKNOWN                       |        |          |
| 1.13 | What the store does with Akeed's answer to the callback, and whether a refused or failed callback leaves the new key in the store.                                                                                               | UNKNOWN                       |        |          |
| 1.14 | "Use of the REST API with the generated keys will conform to that user's WordPress roles and capabilities."                                                                                                                      | DOCUMENTED                    | S1     |          |
| 1.15 | Keys are listed, and can be revoked, in WooCommerce > Settings > Advanced > REST API. "If the WordPress user associated with an API key is deleted, the API key will cease to function."                                         | DOCUMENTED                    | S1     |          |
| 1.16 | Connection is application authentication only. No manual key entry.                                                                                                                                                              | DECIDED (PO, 2026-10-04, #5)  |        |          |

**Correlation method.** The link has no `state` and the callback names no store, so both the organization and the store come from Akeed's own install context:

- **Start.** An owner or admin of a source-less organization on the allow-list enters a store URL. Akeed canonicalizes it (section 2), runs the discovery probe (support boundary), and creates a pending install bound to the organization, the user and the canonical store URL. The row holds the hash of a callback token, an install reference and the hash of the webhook URL token (section 6). It expires in 15 minutes.
- **Callback token.** At least 256 bits from a CSPRNG, base64url, in the **path** of `callback_url`. Stored only as a SHA-256 hash. Single use.
- **Install reference.** A random decimal number of 15 digits, sent as `user_id`. It is not a secret: it appears on `return_url` in the merchant's browser. Because of 1.8 it is digits only, and the callback's `user_id` is compared after converting it to a string, so a JSON string and a JSON number both match.
- **Authorize link.** `app_name=Akeed`, `scope=read_write`, `user_id=<install reference>`, `return_url` on the web app, `callback_url={public API base}/api/woocommerce/install/callback/<callback token>`. The link is returned to the signed-in owner or admin only, used for navigation and never rendered or logged.
- **Callback acceptance.** In this order, and with no stored change until the last step:
  1. The path token is well formed, its hash finds a pending install, and that install is unused, not superseded, not expired, has fewer than 5 failed attempts, and its organization is still on the allow-list with the connect switch on. Every way this can fail gets the same answer (`WOOCOMMERCE_INSTALL_CONTEXT_INVALID`, `401`), and nothing is counted or echoed.
  2. The body has `consumer_key` and `consumer_secret` as bounded printable ASCII, `key_permissions` equal to `read_write`, and `user_id` equal to the install reference. Anything else in the body is ignored.
  3. The keys are proven against the store URL **held in the install context** (section 2). Keys for a different store fail here, whoever posted them.
  4. Akeed's webhooks are created (section 2).
  5. One transaction consumes the install and stores the connection and the `woocommerce` source.
- **Failure.** A refusal after step 1 counts one attempt on the install and stores an error code for the connect screen. The install stays usable, so the same link can be retried until it expires or reaches 5 attempts.

**Worst-case rules:**

- **1.12 (callback origin).** The callback endpoint is public and throttled, answers no CORS preflight, and trusts nothing about the sender: no origin check, no address allow-list. If the gate shows the merchant's browser sends it, connect fails closed and a focused validation story is opened.
- **1.13 (answer to the callback).** Akeed answers `200` with an empty JSON object on success and a coded `4xx` or `503` otherwise. It never echoes a key. Assume a refused or abandoned install leaves a key in the store: the not-completed and error screens tell the merchant where to revoke it (1.15).

**What `return_url` may and may not be used for:**

| `success` | May                                                                                           | May not                                                                                                       |
| --------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `1`       | Show the waiting state and poll Akeed's own connection status until it is connected or failed | Mark the organization connected, consume the install, store anything, or skip waiting for the callback (1.10) |
| `0`       | Show the denied state and offer to try again                                                  | Cancel or consume the install, store anything, or change any connection                                       |

The `user_id` on `return_url` is ignored unless it equals the install reference of the signed-in organization's own latest pending install. The page works the same without it.

## 2. Credentials, store identity and webhook authenticity

| #    | Finding                                                                                                                                                                                                                                                     | Label                         | Source | VERIFIED |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------ | -------- |
| 2.1  | Over HTTPS: "You may use HTTP Basic Auth by providing the REST API Consumer Key as the username and the REST API Consumer Secret as the password."                                                                                                          | DOCUMENTED                    | S1     |          |
| 2.2  | Query-string credentials are a documented fallback for servers that drop the `Authorization` header, and OAuth 1.0a is documented for plain HTTP. Akeed uses neither.                                                                                       | DECIDED (epic scope)          | S1     |          |
| 2.3  | The REST API requires "WooCommerce 3.5+", "WordPress 4.4+" and "Pretty permalinks in Settings > Permalinks (default permalinks will not work)". The base path is `wp-json/wc/v3`.                                                                           | DOCUMENTED                    | S4     |          |
| 2.4  | Errors are `400`, `401` ("Authentication or permission error, e.g. incorrect API keys"), `404` and `500`, with a JSON object holding `code`, `message` and `data`.                                                                                          | DOCUMENTED                    | S4     |          |
| 2.5  | "Occasionally some servers may not parse the Authorization header correctly (if you see a "Consumer key is missing" error when authenticating over SSL, you have a server issue)."                                                                          | DOCUMENTED                    | S1, S4 |          |
| 2.6  | The exact status and `code` for a missing header, a revoked key, and a key whose user lacks permission. `403` is not in the documented list.                                                                                                                | UNKNOWN                       |        |          |
| 2.7  | `GET /wp-json/wc/v3/system_status` returns `environment.home_url` ("Home URL"), `environment.site_url` ("Site URL"), `environment.version` ("WooCommerce version") and `settings.currency`, among others.                                                   | DOCUMENTED                    | S7     |          |
| 2.8  | The capability a key's user needs to read system status, and to manage webhooks.                                                                                                                                                                            | UNKNOWN                       |        |          |
| 2.9  | How `home_url` and `site_url` differ, and which one the REST API and the webhook source header are built from.                                                                                                                                              | UNKNOWN                       |        |          |
| 2.10 | `POST /wp-json/wc/v3/webhooks` takes `name`, `status`, `topic`, `delivery_url` and `secret`. The response has `id`, `status`, `topic`, `resource`, `event`, `hooks`, `delivery_url` and dates. `secret` is marked WRITE-ONLY and is in no example response. | DOCUMENTED                    | S2     |          |
| 2.11 | The delivery URL "must be HTTP or HTTPS".                                                                                                                                                                                                                   | DOCUMENTED                    | S2     |          |
| 2.12 | The secret is "an optional secret key that is used to generate a HMAC-SHA256 hash of the request body so the receiver can verify authenticity of the webhook". `X-WC-Webhook-Signature` is "a base64 encoded HMAC-SHA256 hash of the payload".              | DOCUMENTED                    | S2     |          |
| 2.13 | Core order topics are `order.created`, `order.updated` and `order.deleted`.                                                                                                                                                                                 | DOCUMENTED                    | S2     |          |
| 2.14 | A webhook can be edited in WooCommerce > Settings > Advanced > Webhooks, and the form has a Secret field.                                                                                                                                                   | DOCUMENTED                    | S3, S9 |          |
| 2.15 | Deliveries carry `X-WC-Webhook-Source`. The only description is the example value `http://example.com/`.                                                                                                                                                    | DOCUMENTED                    | S2     |          |
| 2.16 | Which URL `X-WC-Webhook-Source` holds (2.9), and its exact form for a store in a subdirectory.                                                                                                                                                              | UNKNOWN                       |        |          |
| 2.17 | Akeed creates its own webhooks with a secret it generates. The merchant copies nothing.                                                                                                                                                                     | DECIDED (story US-07-02 AC 5) |        |          |
| 2.18 | A canonical store URL can be verified for one organization only.                                                                                                                                                                                            | DECIDED (story US-07-02 AC 6) |        |          |

**Canonical store URL.** The URL is merchant-supplied and treated as hostile. It is accepted only when all of this holds, and it is then stored in one canonical form:

- Scheme `https`. No user or password, no query, no fragment.
- The host is a DNS name with at least one dot: not an IP literal, not `localhost`. It is lowercased and stored in its ASCII (punycode) form.
- No port, or port 443.
- The path is kept, so a store in a subdirectory is supported. Trailing slashes are removed. A path that has an empty segment, a dot segment, a percent sign or a backslash, or that contains `wp-json` or `wc-auth`, is refused.
- At most 255 characters.

The canonical form is `https://<host>` or `https://<host>/<path>`. `www.example.com` and `example.com` are two different canonical URLs.

**Proving the keys.** `GET {canonical store URL}/wp-json/wc/v3/system_status` with Basic authentication, through the restricted client (section 8), outside any transaction. The keys are proven when the answer is `200` with a JSON object that has a string `environment.home_url`. Nothing else in the body is trusted or stored except `environment.version`, kept for support.

**Canonical store identity.** It is the canonical store URL from the install context, and it is accepted only when the store's own `environment.home_url`, canonicalized by the same rules, is equal to it. Two things then agree: Akeed reached and authenticated against this URL, and the store calls itself by it. If they differ the connect is refused with `WOOCOMMERCE_STORE_URL_MISMATCH` and nothing is stored. The store's value is never echoed to the screen or the log.

- The identity is verified at connect, so there is no "claimed" phase as in E06.
- One verified store maps to at most one integration: a partial unique index on the canonical store URL of connected rows. A store verified for another organization is refused with `WOOCOMMERCE_STORE_UNAVAILABLE`.
- A disconnect releases the slot. A reconnect is accepted only for the organization's own disconnected source and only for the same canonical store URL (US-07-05).

**The webhooks Akeed creates.** After the keys are proven and before anything is stored:

1. List the store's webhooks (`GET /wp-json/wc/v3/webhooks`, following `X-WP-TotalPages`, at most 10 pages of 100) and delete every one whose `delivery_url` starts with Akeed's delivery base (`{public API base}/api/woocommerce/webhooks/`). This is what makes a retry or a reconnect replace webhooks instead of adding to them.
2. Create two webhooks, `status: "active"`:

   | `name`                | `topic`         | `delivery_url`                                                   | `secret`           |
   | --------------------- | --------------- | ---------------------------------------------------------------- | ------------------ |
   | `Akeed order created` | `order.created` | `{public API base}/api/woocommerce/webhooks/<webhook URL token>` | the install secret |
   | `Akeed order updated` | `order.updated` | the same URL                                                     | the same secret    |

3. The install secret is 32 bytes from a CSPRNG, base64url. One secret per install, used by both webhooks. It leaves Akeed only in the body of these two requests.
4. If the second creation fails, the first webhook is deleted (best effort) and the callback is refused with `WOOCOMMERCE_WEBHOOK_SETUP_FAILED`. No connection and no source are stored, so nothing is half-connected.

**Webhook authenticity: the three-part check.** In this order, before any business work, for every order delivery:

1. **URL token.** The path token is well formed and its SHA-256 hash finds exactly one connected integration. This alone decides the tenant (section 6).
2. **Raw-body HMAC.** HMAC-SHA256 of `req.rawBody` with that install's decrypted secret. The header value is base64-decoded and compared with `crypto.timingSafeEqual` after a length check. The body is never re-serialized.
3. **Source.** `X-WC-Webhook-Source`, canonicalized by the rules above, equals the integration's canonical store URL.

Any failure answers `401` with one code (`WOOCOMMERCE_WEBHOOK_UNAUTHORIZED`), stores nothing and does not say which part failed. A failure of part 2 or 3 on a valid token adds one to the integration's refused-delivery counter.

**Worst-case rules:**

- **2.6 and 2.8 (error answers).** `401` on any call is "credentials rejected": permanent, needs the merchant, recorded as connection health. `403` is "permission denied": permanent, needs the merchant. Neither is retried in a loop. The message text and the `code` field are not parsed. Because `401` is documented for both wrong keys and missing permission, the merchant message for it names both the missing `Authorization` header and the user's role.
- **2.9 and 2.16 (source header).** The check is strict equality after canonicalization. If a real store sends a different spelling, its deliveries are refused, the refused counter rises and the webhook is eventually disabled: a visible failure, never a wrong acceptance. The comparison at connect against `environment.home_url` is there to catch such a store before any order depends on it.
- **2.14 (merchant edits the webhook).** A changed secret, topic or URL makes deliveries fail the check or stop arriving. Health shows refused deliveries or a missing webhook; the fix is to reconnect.

## 3. Delivery, idempotency and disabling

| #    | Finding                                                                                                                                                                                                                                                                        | Label                        | Source | VERIFIED |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- | ------ | -------- |
| 3.1  | "Delivery is performed using wp_remote_post() (HTTP POST) and processed in the background by default using wp-cron."                                                                                                                                                           | DOCUMENTED                   | S2     |          |
| 3.2  | Headers: `X-WC-Webhook-Source`, `X-WC-Webhook-Topic` ("e.g. order.updated"), `X-WC-Webhook-Resource` ("e.g. order"), `X-WC-Webhook-Event` ("e.g. updated"), `X-WC-Webhook-Signature`, `X-WC-Webhook-ID` ("webhook's post ID"), `X-WC-Webhook-Delivery-ID` ("delivery log ID"). | DOCUMENTED                   | S2     |          |
| 3.3  | "The payload is JSON encoded and for API resources (coupons, customers, orders, products), the response is exactly the same as if requested via the REST API."                                                                                                                 | DOCUMENTED                   | S2     |          |
| 3.4  | The `Content-Type` of a delivery, and which REST version's order shape a webhook created through `wc/v3` sends.                                                                                                                                                                | UNKNOWN                      |        |          |
| 3.5  | A topic "maps to one or more hook names". The example `order.updated` webhook lists `woocommerce_process_shop_order_meta`, `woocommerce_api_edit_order`, `woocommerce_order_edit_status` and `woocommerce_order_status_changed`.                                               | DOCUMENTED                   | S2     |          |
| 3.6  | `order.created` has fired for a checkout draft under the Checkout block: "the webhook "order created" is fired off for a draft checkout, once the customer hits the checkout page". The issue was closed as completed on 2026-09-25.                                           | DOCUMENTED                   | S12    |          |
| 3.7  | "In current WooCommerce versions, a fresh block-based checkout stores form interaction state in the customer session first and creates the draft order when the customer clicks Place Order."                                                                                  | DOCUMENTED                   | S10    |          |
| 3.8  | From which WooCommerce version 3.7 holds, and so whether a given store still sends a draft delivery at page load.                                                                                                                                                              | UNKNOWN                      |        |          |
| 3.9  | "The first time your webhook is saved with the Activated status, it sends a ping to the Delivery URL."                                                                                                                                                                         | DOCUMENTED                   | S3, S9 |          |
| 3.10 | The ping's body, content type and headers, whether it is signed, and what a failed ping does.                                                                                                                                                                                  | UNKNOWN                      |        |          |
| 3.11 | "After 5 consecutive failed deliveries (as defined by a non HTTP 2xx response code), the webhook is disabled and must be edited via the REST API to re-enable."                                                                                                                | DOCUMENTED                   | S2     |          |
| 3.12 | "Webhooks are disabled after 5 retries by default if the delivery URL returns an unsuccessful status such as 404 or 5xx. Successful responses are 2xx, 301 or 302."                                                                                                            | DOCUMENTED                   | S3     |          |
| 3.13 | "WooCommerce automatically disables a webhook after more than five consecutive delivery failures. A failure is any response that is not a 2xx, 301, or 302 HTTP status code."                                                                                                  | DOCUMENTED                   | S9     |          |
| 3.14 | The threshold can be changed by the store with the `woocommerce_max_webhook_delivery_failures` filter.                                                                                                                                                                         | DOCUMENTED                   | S3, S9 |          |
| 3.15 | A webhook's status is `active` ("delivers payload"), `paused` ("delivery paused by admin") or `disabled` ("delivery paused by failure"). It is read with `GET /wp-json/wc/v3/webhooks/<id>`.                                                                                   | DOCUMENTED                   | S2     |          |
| 3.16 | A webhook is changed with `PUT /wp-json/wc/v3/webhooks/<id>`, which takes `status`, and deleted with `DELETE /wp-json/wc/v3/webhooks/<id>`, where `force` is "true whether to permanently delete the webhook".                                                                 | DOCUMENTED                   | S2     |          |
| 3.17 | Whether setting `active` again resets the failure count, and whether it sends another ping.                                                                                                                                                                                    | UNKNOWN                      |        |          |
| 3.18 | The delivery timeout, whether a failed delivery is sent again, duplicate deliveries, and ordering between the two topics.                                                                                                                                                      | UNKNOWN                      |        |          |
| 3.19 | Whether `X-WC-Webhook-Delivery-ID` is unique and stable for one event.                                                                                                                                                                                                         | UNKNOWN                      |        |          |
| 3.20 | Orders placed while a webhook was disabled, or while the source was not ready, are not imported later.                                                                                                                                                                         | DECIDED (PO, 2026-10-04, #7) |        |          |

**The disable rule and what Akeed therefore answers.** The three statements (3.11 to 3.13) do not agree on the count or on `301` and `302`. Akeed follows the strictest reading: any answer that is not `2xx` is a failure, and the fifth in a row disables the webhook. Because of 3.14 the real number on a store may be lower or higher. Akeed never answers `3xx`.

| Situation                                                                                          | Answer | Stored                   | A failure at the store |
| -------------------------------------------------------------------------------------------------- | ------ | ------------------------ | ---------------------- |
| `WOOCOMMERCE_INGESTION_ENABLED` off, an order delivery                                             | `404`  | Nothing                  | Yes                    |
| Token unknown, malformed, rotated or wiped by a disconnect                                         | `401`  | Nothing                  | Yes                    |
| Token of a pending install whose connect is still running                                          | `200`  | Nothing                  | No                     |
| Known token, the request is not an order delivery (the ping rule below), with the switch on or off | `200`  | Nothing                  | No                     |
| Order delivery, HMAC or source check fails                                                         | `401`  | Nothing; refused counter | Yes                    |
| Order delivery, checks pass, no usable order `id` in the body                                      | `200`  | Nothing; logged          | No                     |
| Order delivery accepted and its event row written, whatever the routing (create, update, skipped)  | `200`  | Event row                | No                     |
| The same, and the queue is down                                                                    | `200`  | Event row                | No                     |
| The same, a repeat of an event already stored                                                      | `200`  | Nothing new              | No                     |
| The event row cannot be written                                                                    | `500`  | Nothing                  | Yes                    |

The `200` is sent only after `WebhookQueueProducer.ingest` has written the `webhook_events` row. A queue outage is recovered by the existing dispatch reconciler. An unwritten row is logged as a possibly lost event, apart from a refused delivery.

**Consequences:**

- **Ingestion off disables webhooks.** A store connected while `WOOCOMMERCE_INGESTION_ENABLED` is off gets `404` for every order, so after five orders its webhooks are disabled. Rollout rule: turn ingestion on before a pilot organization connects. A store connected earlier needs its webhooks re-enabled (US-07-05) when ingestion is turned on.
- **After a disconnect** the token is gone, so any leftover webhook gets `401` and disables itself. That is the intended end state when the REST deletion failed.
- **A wrong secret or source** disables the webhooks within five orders. Health shows the refused count and the `disabled` state.

**Ping rule.** A request is an **order delivery** when `X-WC-Webhook-Topic` is `order.created` or `order.updated`. Any other request on a known token (the token of a connection, or of a pending install whose connect is in flight) is answered `200` with an empty body: nothing is stored, nothing is counted and no check beyond the token is made. This covers the ping whatever its body is (3.10), including the one that arrives while the callback is still creating the webhooks. It gives away nothing: the caller already holds the token, and no state changes. On an unknown token the answer is `401`, or `404` while ingestion is off.

**Detecting and re-enabling a disabled webhook.** There is no background poll. The state of both webhooks is read from the store (3.15) when health is read, when the connection is checked and before a re-enable:

- `disabled`: shown in health and as a setup blocked reason. An owner or admin re-enables it from Akeed: `PUT … { "status": "active" }`, then a read to confirm.
- `paused`: shown as it is. The merchant paused it in WooCommerce; Akeed does not override that.
- `404`: the webhook was deleted at the store. Shown as missing; the fix is to reconnect.

**Worst-case rules:**

- **3.4.** The raw body is parsed as JSON whatever the `Content-Type` says, and it must be available as raw bytes for any content type on this route. Only the fields in section 4 are read.
- **3.8.** A draft is never a start: the status allow-list in section 4 decides, not the topic and not the WooCommerce version.
- **3.17.** Assume the count is not reset: after a re-enable Akeed must not answer a single non-`2xx` to a valid delivery. A ping after re-enabling is covered by the ping rule.
- **3.18.** Assume a short timeout, no second attempt, at-least-once delivery and any order. Persist first and answer fast; do no remote call and no heavy work before the answer. Processing is safe to re-run and does not depend on arrival order.
- **3.19.** `X-WC-Webhook-Delivery-ID` and `X-WC-Webhook-ID` are kept for audit only. They are never an idempotency key.

## 4. Payload and COD mapping

| #    | Finding                                                                                                                                                                                                                                                                                           | Label                         | Source | VERIFIED |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------ | -------- |
| 4.1  | An order has `id` (integer), `number` (string), `status`, `currency` ("Currency the order was created with, in ISO format"), `date_created_gmt`, `date_modified_gmt`, `total` (string, "Grand total"), `billing`, `payment_method` ("Payment method ID"), `payment_method_title` and `meta_data`. | DOCUMENTED                    | S5     |          |
| 4.2  | `billing` has `first_name`, `last_name`, `phone` ("Phone number") and `country` ("Country code in ISO 3166-1 alpha-2 format"). The documented `shipping` object has no phone.                                                                                                                     | DOCUMENTED                    | S5     |          |
| 4.3  | "Resource IDs are returned as integers". "Any decimal monetary amount, such as prices or totals, will be returned as strings with two decimal places". "Blank fields are generally included as null or empty string instead of being omitted".                                                    | DOCUMENTED                    | S4     |          |
| 4.4  | "Dates are returned in ISO8601 format: YYYY-MM-DDTHH:MM:SS", with no zone suffix. `date_created_gmt` is "The date the order was created, as GMT".                                                                                                                                                 | DOCUMENTED                    | S4, S5 |          |
| 4.5  | `status` options are "pending, processing, on-hold, completed, cancelled, refunded, failed and trash. Default is pending."                                                                                                                                                                        | DOCUMENTED                    | S5     |          |
| 4.6  | A Draft status exists: "Draft orders are temporary checkout records used by the block-based checkout before an order is submitted."                                                                                                                                                               | DOCUMENTED                    | S10    |          |
| 4.7  | The value `status` holds for a draft. It is not among the options in 4.5.                                                                                                                                                                                                                         | UNKNOWN                       |        |          |
| 4.8  | The core Cash on Delivery gateway has the ID `cod` ("Cash on delivery").                                                                                                                                                                                                                          | DOCUMENTED                    | S8     |          |
| 4.9  | "WooCommerce sets orders using Cash on Delivery (COD) to "Processing" until payment is collected."                                                                                                                                                                                                | DOCUMENTED                    | S11    |          |
| 4.10 | On hold: "The order is awaiting payment confirmation. Stock is reduced, but you need to confirm payment." It is "generally assigned to an order when a customer pays via an "offline" payment method".                                                                                            | DOCUMENTED                    | S10    |          |
| 4.11 | Pending payment: "The order has been received, but no payment has been made."                                                                                                                                                                                                                     | DOCUMENTED                    | S10    |          |
| 4.12 | The statuses that count as placed are `processing` and `on-hold`.                                                                                                                                                                                                                                 | DECIDED (record, 2026-10-04)  |        |          |
| 4.13 | Only `payment_method` equal to `cod` is cash on delivery. Custom gateways and custom statuses are out of scope.                                                                                                                                                                                   | DECIDED (epic scope)          |        |          |
| 4.14 | Currency and phone country are not merchant inputs: they come from each order.                                                                                                                                                                                                                    | DECIDED (story US-07-05 AC 1) |        |          |

On 4.12: the documentation names only Processing for a COD order (4.9). `on-hold` is included so that a store whose COD orders are held still gets verified; an `on-hold` order that is not COD is skipped anyway. The real status on classic checkout and on the Checkout block is a gate observation.

**The ingestion rule.** One pure policy decides the route. The webhook service uses it to pick the idempotency key, and the normalizer uses the same policy for the recorded reason.

A delivery **starts a verification** when all of this holds, on either topic:

- `payment_method` is `cod`;
- `status` is `processing` or `on-hold`;
- `date_created_gmt`, read as UTC, is not earlier than the moment the source was connected or last reconnected. A missing or unreadable date counts as earlier.

| Route   | When                                                               | Job type       | Idempotency key                                                       |
| ------- | ------------------------------------------------------------------ | -------------- | --------------------------------------------------------------------- |
| Create  | Akeed has no create event for this order, and the start rule holds | `ORDER_CREATE` | `order.create:<integrationId>:<orderId>`                              |
| Update  | Akeed already has a create event for this order                    | `ORDER_UPDATE` | `order.update:<integrationId>:<orderId>:<status>:<date_modified_gmt>` |
| Skipped | Neither                                                            | `ORDER_CREATE` | `order.skip:<integrationId>:<orderId>:<status>:<date_modified_gmt>`   |

- "Akeed already has a create event" is a lookup of the create key under this source in `webhook_events` (`findBySourceAndIdempotency`). It is true from the moment the first create delivery is accepted.
- **A skipped delivery never uses the create key.** A checkout draft stored under `order.create:…` would turn the later placed delivery into a duplicate, and the order would never be verified. Skipped deliveries have their own key, so draft then placed gives one verification.
- `order.created` and `order.updated` arriving together for a placed order both resolve to the create key. The unique index keeps one row; the other is a duplicate. One logical order, one verification.
- The same order `id` from two stores stays apart: the key holds the integration, and the event's source identity is `woocommerce:<orgId>` (section 6).
- An update is recorded and handed to the `WebhookOrderUpdateHandler` (section 5). It never starts a verification.

**Skip reasons**, evaluated in this order and recorded on the event by the normalizer:

| Reason                      | When                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `order_predates_connection` | `date_created_gmt` is earlier than the connection, or unreadable                                             |
| `order_not_placed`          | `status` is anything but `processing` or `on-hold`: a draft, `pending`, a terminal status or a custom status |
| `non_cod_payment_method`    | `payment_method` is set and is not `cod`                                                                     |
| `missing_payment_signal`    | `payment_method` is empty                                                                                    |

`non_cod_payment_method` and `missing_payment_signal` are the names `OrderEligibilityResult` already uses. A draft and a custom status share `order_not_placed` because telling them apart would need the undocumented value in 4.7; the status itself stays in the stored payload for support.

**Mapping to `NormalizedOrder`** (create route only):

| Field             | From                                                  | Rule                                                                                                                                                            | When missing or invalid               |
| ----------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `orgId`           | The URL token's integration                           | Never from the payload                                                                                                                                          | The event is not accepted (section 2) |
| `integrationId`   | The URL token's integration                           | Never from the payload                                                                                                                                          | The event is not accepted             |
| `externalOrderId` | `id`                                                  | A positive integer, written as decimal text                                                                                                                     | Not stored; answered `200` and logged |
| `orderNumber`     | `number`                                              | Text as given                                                                                                                                                   | Left out                              |
| `customerName`    | `billing.first_name`, `billing.last_name`             | Joined with a space and trimmed                                                                                                                                 | Left out                              |
| `customerPhone`   | `billing.phone`, with `billing.country` as the region | An international number is taken as it is. A local number is read in the billing country and written as E.164 by `PhoneService`. Nothing is guessed from an IP. | See below                             |
| `totalPrice`      | `total`                                               | Decimal text, kept as text                                                                                                                                      | `invalid_amount`                      |
| `currency`        | `currency`                                            | Three letters, upper case, checked with `isCanonicalCurrency`                                                                                                   | `missing_currency`                    |
| `paymentMethod`   | `payment_method`                                      | As given                                                                                                                                                        | (cannot be missing on this route)     |
| `paymentSignals`  | `payment_method`                                      | One entry                                                                                                                                                       |                                       |
| `codStatus`       | `payment_method`                                      | `cod` for `cod`                                                                                                                                                 |                                       |
| `rawPayload`      | The order                                             | The delivered object                                                                                                                                            |                                       |

Phone reasons: no `billing.phone` is `incomplete_payload`; a local number with no `billing.country` is `missing_phone_country`; a number that does not parse for that country is `invalid_phone`. `missing_currency`, `invalid_amount`, `invalid_phone`, `missing_phone_country` and `incomplete_payload` are reason codes the EasyOrders normalizer already records, so the frontend reason map already knows them.

**Fixtures.** [`test/fixtures/woocommerce/`](../../../../test/fixtures/woocommerce/README.md) holds an order as a checkout draft, as a placed COD order, as a placed non-COD order and as an updated order, plus a ping. They are built from the documented order shape (4.1 to 4.4) with synthetic values and are marked "documented, not captured". Two parts of them are assumptions and are labelled so in the folder: the draft's status value (4.7) and the ping body (3.10). No rule in this record reads either.

The `woocommerce` `OrderEligibilityStrategy` repeats the COD test (`cod` is `cod_match`, any other value `non_cod_payment_method`, none `missing_payment_signal`), so the core never falls back to another platform's rule. There is no order lookup on this path.

## 5. Outcome mapping

| #    | Finding                                                                                                                                                                                                                         | Label                        | Source  | VERIFIED |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------- | -------- |
| 5.1  | An order is read with `GET /wp-json/wc/v3/orders/<id>` and changed with `PUT /wp-json/wc/v3/orders/<id>`. `status` and `meta_data` are writable.                                                                                | DOCUMENTED                   | S5      |          |
| 5.2  | A `meta_data` entry has `id` ("Meta ID", READ-ONLY), `key` and `value`.                                                                                                                                                         | DOCUMENTED                   | S5      |          |
| 5.3  | Whether sending a `key` that already exists adds a second entry or replaces the first.                                                                                                                                          | UNKNOWN                      |         |          |
| 5.4  | `set_paid` "will set the status to processing and reduce stock items". Akeed never sends it.                                                                                                                                    | DOCUMENTED                   | S5      |          |
| 5.5  | A note is added with `POST /wp-json/wc/v3/orders/<id>/notes`. `customer_note`: "If true, the note will be shown to customers and they will be notified. If false, the note will be for admin reference only. Default is false." | DOCUMENTED                   | S6      |          |
| 5.6  | Nothing prevents the same note being added twice. The page documents no idempotency for notes.                                                                                                                                  | UNKNOWN                      |         |          |
| 5.7  | Example responses carry `_links.self[0].href`, for instance `https://example.com/wp-json/wc/v3/orders/727`.                                                                                                                     | DOCUMENTED                   | S5      |          |
| 5.8  | The documented statuses have no "confirmed". Processing "is the store owner's or warehouse's cue to ship the order"; Completed means "The order has been fulfilled and is complete."                                            | DOCUMENTED                   | S5, S10 |          |
| 5.9  | "When an order has the Cancelled status, stock for line items on the order is returned to the store's inventory if inventory management is enabled."                                                                            | DOCUMENTED                   | S10     |          |
| 5.10 | "WooCommerce sends specific emails to you and your customers when order statuses change." Which emails a cancellation sends is not stated.                                                                                      | UNKNOWN                      |         |          |
| 5.11 | Which statuses may move to `cancelled` through REST, and the answer to a refused transition.                                                                                                                                    | UNKNOWN                      |         |          |
| 5.12 | Whether a REST update, and a meta-only update in particular, comes back as an `order.updated` delivery.                                                                                                                         | UNKNOWN                      |         |          |
| 5.13 | Customer confirmation writes an order note and an Akeed meta marker and changes no status.                                                                                                                                      | DECIDED (PO, 2026-10-04, #2) |         |          |
| 5.14 | Customer cancellation and merchant no-reply cancellation write `cancelled`. The side effects (stock restored, cancellation email) are accepted.                                                                                 | DECIDED (PO, 2026-10-04, #3) |         |          |
| 5.15 | Automatic no-reply stays local. It never cancels an order in WooCommerce.                                                                                                                                                       | DECIDED (PO, 2026-10-04, #4) |         |          |
| 5.16 | An outcome may be written only while the order's current status is `processing` or `on-hold`. Every other status, including a custom one, is a conflict and is not overwritten.                                                 | DECIDED (record, 2026-10-04) |         |          |
| 5.17 | The marker is the meta key `akeed_outcome` with the value `<action>:<correlationId>`.                                                                                                                                           | DECIDED (record, 2026-10-04) |         |          |
| 5.18 | The confirmation note is internal (`customer_note: false`) and has a fixed text with no customer data. A cancellation adds no note of Akeed's own.                                                                              | DECIDED (record, 2026-10-04) |         |          |

**Approved mapping** (against `CommerceOutcomeAction` in [`commerce-outcome.ts`](../../../../src/shared/commerce/commerce-outcome.ts)):

| Akeed action                     | WooCommerce effect                                | Side effects                                                        | Adapter capability                              |
| -------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------- |
| `customer_confirmation`          | Marker and one internal note. No status change.   | None documented. The customer is not notified (5.5).                | yes                                             |
| `customer_cancellation`          | `status: cancelled` and the marker, in one update | Stock returned when inventory management is on (5.9); emails (5.10) | yes                                             |
| `merchant_no_reply_cancellation` | The same, only on an explicit merchant action     | The same                                                            | yes                                             |
| `automatic_no_reply_tagging`     | None                                              | None                                                                | no → `unsupported` / `capability_not_supported` |
| `merchant_cancellation_tagging`  | None. WooCommerce orders have no tags.            | None                                                                | no → `unsupported` / `capability_not_supported` |

It never sets `processing`, `completed`, `refunded` or `set_paid`. With `WOOCOMMERCE_OUTCOME_SYNC_ENABLED` off the adapter has no capability: every outcome is recorded as unsupported and no request is made.

**The idempotent write.** Every call uses the connection and keys of the order's own integration, through the restricted client.

1. **Read** the order. The answer is this store's order only when its `id` equals the requested one and its `_links.self[0].href`, canonicalized, lies under the integration's canonical store URL. Otherwise the result is `store_unverified` and nothing is written.
2. **Decide** from what was read:

   | Read shows                                                                                   | Result                                                              | Request   |
   | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------- |
   | The marker for this action and correlation, and for a cancellation the status is `cancelled` | `applied`                                                           | None      |
   | A cancellation, and the status is already `cancelled`                                        | `applied`                                                           | None      |
   | A status other than `processing` or `on-hold`                                                | `permanent_failure` / `remote_state_conflict`, with the status seen | None      |
   | Otherwise                                                                                    | Write                                                               | One `PUT` |

3. **Write** one `PUT` carrying the marker, and `status: "cancelled"` for the two cancellations. The marker and the status travel together, so a repeat cannot leave one without the other.
4. **Note**, for a confirmation only, and only when the read in step 1 showed no marker: one `POST …/notes` with `customer_note: false`. Because the marker is written first, a retry sees the marker and adds no second note. The note is written at most once.
5. **Lost answer.** A timeout or a broken connection after the `PUT` was sent is ambiguous. The order is read back before anything is tried again: the marker present (and `cancelled` for a cancellation) is `applied`; still writable without the marker is `retryable_failure` / `write_unconfirmed`; any other status is `remote_state_conflict`. Success is reported only for a state the store confirmed.

**Known limit of the note.** If the note request fails after the marker was written, the outcome is still `applied` and the failure is logged: the marker is the record, and a retry must not risk a second note. A confirmation can therefore end with the marker and no note. This is the price of "at most once" under 5.6.

**Failure mapping** (results of `CommerceOutcomeOperationResult`):

| Answer                                        | Result                                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `401`                                         | `permanent_failure` / `source_credentials_rejected`, `requiresAssistance`; health set to credentials rejected |
| `403`                                         | `permanent_failure` / `source_permission_denied`, `requiresAssistance`                                        |
| `404` on the order                            | `permanent_failure` / `order_not_found`                                                                       |
| `400` on the write                            | `permanent_failure` / `remote_rejected`                                                                       |
| `429` or `503`                                | `retryable_failure` with `retryAfterMs` from `Retry-After` (section 8)                                        |
| Other `5xx`, timeout or network before a send | `retryable_failure` / `source_unavailable`                                                                    |
| A response refused by the restricted client   | `permanent_failure` / `store_unreachable`, `requiresAssistance`                                               |

`providerStatus` is the status read from the store when it is at most 64 printable ASCII characters, as the sync policy already requires; otherwise it is left out.

**Echo handling.** The `woocommerce` `WebhookOrderUpdateHandler` receives every update for an order Akeed already has. It looks the order up under the integration the URL token resolved to (`order_not_owned` if there is none), then:

- `reflected_outcome`: the payload's `meta_data` holds an `akeed_outcome` entry equal to the marker of an outcome recorded for that order in `commerce_outcome_syncs` in any state but `unsupported`. A waiting or failed row counts, because the write may have been taken even though its answer never arrived.
- `remote_status_observed`: anything else. The merchant changed the order in WooCommerce.

Neither changes a verification, writes to the store or starts a verification, so there is no loop.

**Worst-case rules:**

- **5.3.** The marker is sent only when the read shows no entry with this exact value. A read that finds more than one `akeed_outcome` entry treats any entry with the wanted value as present.
- **5.10 and 5.11.** Writes stay off for every merchant until the gate has shown the real effect of the note, the marker and `cancelled` on a store (US-07-04 rollout). A refused transition is `remote_rejected` and is not retried.
- **5.12.** Assume every write comes back as `order.updated`. The echo rule above makes that harmless.

## 6. Tenant resolution

| #   | Finding                                                                                                        | Label                         | Source | VERIFIED |
| --- | -------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------ | -------- |
| 6.1 | A delivery is sent to the webhook's `delivery_url`, which Akeed sets when it creates the webhook.              | DOCUMENTED                    | S2     |          |
| 6.2 | The order payload has no field that names an Akeed tenant. `X-WC-Webhook-Source` is the store's own statement. | DOCUMENTED                    | S2, S5 |          |
| 6.3 | The tenant signal is a per-install token in the delivery URL, looked up by hash.                               | DECIDED (story US-07-03 AC 1) |        |          |
| 6.4 | A store admin can see the delivery URL, token included, in the store's webhook settings.                       | DOCUMENTED                    | S3, S9 |          |
| 6.5 | One source per organization. Only a fresh or unprovisioned organization can connect. No source switching.      | DECIDED (epic rule)           |        |          |

**Mechanism:**

- **Webhook URL token.** At least 256 bits from a CSPRNG, base64url, in the **path** of the delivery URL. It is a different value from the callback token. It is generated when the install starts, because the ping arrives before the connection row exists.
- Stored only as a SHA-256 hash, unique across pending installs and across connections. The lookup is by hash, so one token resolves to exactly one integration and one organization, or to nothing.
- The token alone decides the tenant. `orgId` and `integrationId` on the event come from it and never from the payload or a header. The HMAC and the source header then prove the delivery belongs to that tenant's store.
- **Source identity.** The integration's `platform_store_url` is `woocommerce:<orgId>`, as EasyOrders uses `easyorders:<orgId>`. The real store URL lives on the connection row. This keeps the `integrations` unique key and `webhook_events.store_domain` free of merchant-supplied text, and lets `WebhookQueueProducer.ingest` find the integration as it does today.
- **Rotation.** A reconnect issues a new token and a new secret and replaces the webhooks in the same flow; the old hash is replaced in the same transaction. A disconnect wipes the hash. A delivery to an old URL gets `401` and stores nothing.
- **Outbound scope.** Every REST call is built from the connection row found by `integrationId` and `orgId` together. Every order lookup is by `orgId`, `integrationId` and `externalOrderId` together. An id that belongs to another tenant resolves to nothing.

**Proof status:**

| Claim                                      | Status                                                                                                                                                                                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cannot be guessed                          | Holds by construction (256-bit random, hash lookup).                                                                                                                                                                              |
| Cannot be reused across tenants            | Holds by construction: one hash, one integration, and the HMAC secret is per install. Owed as contract tests in US-07-03: tenant A's token with tenant B's signature is refused; the same order `id` from two stores stays apart. |
| Not accepted after disconnect or reconnect | Holds by construction: the hash is wiped or replaced. Owed as contract tests in US-07-05.                                                                                                                                         |
| A callback cannot attach another store     | Holds by construction: the keys are proven against the store URL in the install context (section 1). Owed as a contract test in US-07-02.                                                                                         |

## 7. Secret handling

| #   | Finding                                                                                                                                    | Label                         | Source | VERIFIED |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- | ------ | -------- |
| 7.1 | The consumer key and secret reach Akeed once, in the callback body, over HTTPS.                                                            | DOCUMENTED                    | S1     |          |
| 7.2 | The secret is shown to the merchant once: "the secret will be hidden if you try to view the key again".                                    | DOCUMENTED                    | S4     |          |
| 7.3 | The webhook secret is set by Akeed and is write-only in the REST API.                                                                      | DOCUMENTED                    | S2     |          |
| 7.4 | The REST v3 reference lists no resource for API keys. Keys are managed in the admin screen, which has a "Revoke API Key button".           | DOCUMENTED                    | S1, S2 |          |
| 7.5 | Whether a key can be removed by any REST call.                                                                                             | UNKNOWN                       |        |          |
| 7.6 | Consumer keys, webhook secrets and URL tokens are encrypted or hashed at rest and never logged, returned, put in a URL or put in fixtures. | DECIDED (epic rule)           |        |          |
| 7.7 | Disconnect deletes Akeed's webhooks through REST as best effort. Removing the API key in WooCommerce is a manual step.                     | DECIDED (story US-07-05 AC 5) |        |          |

| Secret            | Where it travels                                                              | At rest                                            | Rule                                                                                     |
| ----------------- | ----------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Consumer key      | Callback body in; `Authorization` header out                                  | Ciphertext (`encryptToken`, `v1:` envelope)        | Never in a query string, a log, a response or a fixture                                  |
| Consumer secret   | The same                                                                      | Ciphertext                                         | The same                                                                                 |
| Webhook secret    | Body of the two webhook-creation requests                                     | Ciphertext. It must be readable to check the HMAC. | Generated by Akeed, never shown, never returned                                          |
| Callback token    | Path of `callback_url`, which is itself a value in the authorize link's query | SHA-256 hash                                       | Single use, 15 minutes. Useless without keys that work on the store bound to the install |
| Webhook URL token | Path of the delivery URL, stored at the store                                 | SHA-256 hash                                       | Never returned or logged. Visible to the store's admins (6.4), which is acceptable       |
| Install reference | `user_id` in the link, the callback and `return_url`                          | Plain                                              | Not a secret. Proves nothing alone                                                       |

- The encryption key is the one `encryptToken` already uses (`SHOPIFY_TOKEN_ENCRYPTION_KEY`). Boot fails if any WooCommerce switch is on without it, as the EasyOrders config does.
- New sensitive field names (`consumer_key`, `consumer_secret` and their camel-case forms) are added to `REDACTED_KEYS`. The request log must not record the path of the callback and delivery routes with the token in it.
- No DTO returns a key, a secret, a token or the authorize link after the start call. The connection status returns the canonical store URL, the health and the webhook states only.
- **Disconnect.** Akeed deletes its two webhooks (`DELETE … ?force=true`) while it still holds the keys; a failure is reported and does not block. Then the ciphertexts, the token hash and the webhook ids are wiped in one transaction. History stays.
- **7.5.** The key is removed by the merchant: WooCommerce > Settings > Advanced > REST API, then revoke the key named for Akeed. The disconnect screen and the runbook say so. Until the gate shows otherwise Akeed makes no call to remove a key.

## 8. Limits and timeouts

| #   | Finding                                                                                                                                                                              | Label                    | Source | VERIFIED |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ | ------ | -------- |
| 8.1 | No page states a request rate limit.                                                                                                                                                 | UNKNOWN                  |        |          |
| 8.2 | There is no per-store request budget.                                                                                                                                                | DECIDED (story US-07-04) |        |          |
| 8.3 | "Requests that return multiple items will be paginated to 10 items by default." Totals are in `X-WP-Total` and `X-WP-TotalPages`. Batch calls are limited to 100 objects by default. | DOCUMENTED               | S4, S2 |          |
| 8.4 | Some servers refuse `PUT` and `DELETE`: "if not you can use the `_method` property". ModSecurity can answer `501 Method Not Implemented`.                                            | DOCUMENTED               | S4     |          |
| 8.5 | The answers a host, CDN or firewall in front of the store gives when it throttles.                                                                                                   | UNKNOWN                  |        |          |
| 8.6 | How long WooCommerce waits for Akeed's answer to a delivery or to the install callback.                                                                                              | UNKNOWN                  |        |          |

**Rules:**

- **8.1 and 8.5.** Akeed sends few requests per store: about five at connect, two or three per outcome, two per health read. It keeps no rate limiter. `429` and `503` are retryable; `Retry-After` in seconds or as an HTTP date becomes `retryAfterMs`, and the existing policy clamps it and bounds the number of deferrals. Without the header the existing backoff applies. After the last attempt the outcome stays recorded locally with a visible failed state and a manual retry.
- **8.4.** Akeed does not use `_method`. A `405` or `501` on a write is permanent and needs assistance: the store's hosting is outside the support boundary.
- **8.6.** The delivery answer follows 3.18. The callback does all its store calls inside one request from the store, so the whole callback has a 30-second budget; past it the callback is refused with `WOOCOMMERCE_PROVIDER_UNAVAILABLE` and the link can be retried.

**The restricted outbound client.** A new module under `src/shared/http/`, used for every request to a store: the discovery probe, the key proof, webhook management, order reads and writes, health reads. [`bounded-http.ts`](../../../../src/shared/http/bounded-http.ts) gives deadlines and retries and has no address rules, so it is not enough alone. Nothing existing is moved onto the new client.

1. `https:` only, port 443 only. The URL is built from the stored canonical store URL and a fixed path. No part of a URL comes from a payload or a response.
2. The host is resolved once. **Every** address returned must be public: no private, loopback, link-local, carrier-grade NAT, multicast, unspecified or reserved range, in IPv4 and IPv6, including IPv4-mapped and NAT64 forms. One bad address refuses the request.
3. The connection is made to the address that was checked, with the hostname kept for TLS name checking and SNI. The name is not resolved a second time.
4. TLS certificates are verified. There is no option to turn that off.
5. Redirects are never followed. A `3xx` is an error. This is stricter than "no redirect into a private range", and it also keeps credentials from being forwarded to another host.
6. A 10-second deadline for the whole request. No retry inside the client; a caller that may repeat a call says so, as with `boundedCall`.
7. The response body is read up to 1 MiB (2 MiB for system status) and the read stops there. A larger body is an error.
8. Only `Authorization`, `Content-Type`, `Accept` and `User-Agent` are sent. No cookie is stored or sent.
9. Errors carry a code and no remote text. The host is logged; the path, the headers and the body are not.

## Support boundary

A store is supported when it has all of this. Akeed promises nothing about hosting, plugins or versions beyond it.

- A public HTTPS address on the default port, at the root of a domain or in a subdirectory.
- Pretty permalinks, so that `wp-json/wc/v3` answers (WooCommerce 3.5 or later).
- The `Authorization` header reaching WordPress.
- A WordPress user who can manage WooCommerce authorizing the connection.
- The core Cash on Delivery gateway (`cod`) and the core order statuses.
- `PUT` and `DELETE` accepted by the host.

**Detection.** Before returning the authorize link, the start call sends one unauthenticated `GET {canonical store URL}/wp-json/wc/v3` through the restricted client. What that address returns is not documented, so only this is read from it: a `404` means the REST API is not there; no answer, a TLS failure or a redirect is refused with its own code; any other answer lets the merchant continue. The real proof is the authenticated read after the callback.

**Unsupported cases.** Each is refused without storing a connection. The messages are the copy for the connect screen; the keys go in both `ar.json` and `en.json`.

| Case                                                                     | Detected              | Code                                   | HTTP  |
| ------------------------------------------------------------------------ | --------------------- | -------------------------------------- | ----- |
| The address is not a usable URL (credentials, query, port, IP literal)   | Start                 | `WOOCOMMERCE_STORE_URL_INVALID`        | `400` |
| The address is not HTTPS                                                 | Start                 | `WOOCOMMERCE_STORE_HTTPS_REQUIRED`     | `400` |
| The host does not resolve, or resolves to a non-public address           | Start, and every call | `WOOCOMMERCE_STORE_ADDRESS_NOT_PUBLIC` | `422` |
| The address redirects                                                    | Start, and every call | `WOOCOMMERCE_STORE_REDIRECTS`          | `422` |
| The TLS certificate is not valid                                         | Start, and every call | `WOOCOMMERCE_STORE_TLS_FAILED`         | `422` |
| `wp-json/wc/v3` answers `404` (plain permalinks, or WooCommerce too old) | Start, callback       | `WOOCOMMERCE_REST_NOT_FOUND`           | `422` |
| No answer, a timeout, a `5xx` or a body that is not JSON                 | Start, callback       | `WOOCOMMERCE_REST_UNREACHABLE`         | `503` |
| The new keys get `401` (header not arriving, or key not accepted)        | Callback              | `WOOCOMMERCE_CREDENTIALS_REJECTED`     | `422` |
| The keys get `403`, or `key_permissions` is not `read_write`             | Callback              | `WOOCOMMERCE_PERMISSION_DENIED`        | `422` |
| The store reports a different address from the one entered               | Callback              | `WOOCOMMERCE_STORE_URL_MISMATCH`       | `422` |
| The webhooks could not be created                                        | Callback              | `WOOCOMMERCE_WEBHOOK_SETUP_FAILED`     | `503` |
| The store is already connected to another Akeed organization             | Callback              | `WOOCOMMERCE_STORE_UNAVAILABLE`        | `409` |

| Code                                   | English                                                                                                                                                                                                                                                             | Arabic                                                                                                                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WOOCOMMERCE_STORE_URL_INVALID`        | Enter your store's address, for example `https://example.com`.                                                                                                                                                                                                      | أدخل عنوان متجرك، مثل `https://example.com`.                                                                                                                                                                                             |
| `WOOCOMMERCE_STORE_HTTPS_REQUIRED`     | Your store's address must start with https://. Akeed does not connect to stores without HTTPS.                                                                                                                                                                      | يجب أن يبدأ عنوان متجرك بـ https://. لا يتصل أكيد بالمتاجر التي لا تستخدم HTTPS.                                                                                                                                                         |
| `WOOCOMMERCE_STORE_ADDRESS_NOT_PUBLIC` | Akeed could not reach this address on the public internet. Check the address and try again.                                                                                                                                                                         | تعذّر على أكيد الوصول إلى هذا العنوان عبر الإنترنت. تحقق من العنوان وحاول مرة أخرى.                                                                                                                                                      |
| `WOOCOMMERCE_STORE_REDIRECTS`          | This address redirects to another one. Enter your store's final address, with or without www, exactly as it appears in the browser.                                                                                                                                 | هذا العنوان يحوّل إلى عنوان آخر. أدخل العنوان النهائي لمتجرك، مع www أو بدونها، كما يظهر في المتصفح تمامًا.                                                                                                                              |
| `WOOCOMMERCE_STORE_TLS_FAILED`         | Your store's security certificate is not valid. Ask your hosting provider to fix it, then try again.                                                                                                                                                                | شهادة الأمان لمتجرك غير صالحة. اطلب من شركة الاستضافة إصلاحها ثم حاول مرة أخرى.                                                                                                                                                          |
| `WOOCOMMERCE_REST_NOT_FOUND`           | Akeed could not find the WooCommerce REST API at this address. In WordPress, open Settings > Permalinks, choose any option other than Plain, and make sure WooCommerce is up to date.                                                                               | لم يعثر أكيد على واجهة WooCommerce REST API في هذا العنوان. في ووردبريس افتح الإعدادات > الروابط الدائمة واختر أي خيار غير «عادي»، وتأكد من تحديث WooCommerce.                                                                           |
| `WOOCOMMERCE_REST_UNREACHABLE`         | Your store did not answer. It may be down, in maintenance mode or blocking outside requests. Try again later or ask your hosting provider.                                                                                                                          | لم يستجب متجرك. قد يكون متوقفًا أو في وضع الصيانة أو يحظر الطلبات الخارجية. حاول لاحقًا أو تواصل مع شركة الاستضافة.                                                                                                                      |
| `WOOCOMMERCE_CREDENTIALS_REJECTED`     | Your store did not accept the new API key. Some hosting setups remove the Authorization header before it reaches WordPress; ask your hosting provider to allow it. Then delete the unused key under WooCommerce > Settings > Advanced > REST API and connect again. | لم يقبل متجرك مفتاح الـ API الجديد. بعض إعدادات الاستضافة تحذف ترويسة Authorization قبل وصولها إلى ووردبريس؛ اطلب من شركة الاستضافة السماح بها. ثم احذف المفتاح غير المستخدم من WooCommerce > الإعدادات > متقدم > REST API وأعد الاتصال. |
| `WOOCOMMERCE_PERMISSION_DENIED`        | The WordPress user who approved the connection cannot manage WooCommerce. Sign in to your store as an administrator or shop manager and connect again.                                                                                                              | مستخدم ووردبريس الذي وافق على الاتصال لا يملك صلاحية إدارة WooCommerce. سجّل الدخول إلى متجرك كمدير أو كمدير متجر وأعد الاتصال.                                                                                                          |
| `WOOCOMMERCE_STORE_URL_MISMATCH`       | Your store reports a different address from the one you entered. Enter the address exactly as it is set in WordPress, then connect again.                                                                                                                           | متجرك يعرّف نفسه بعنوان مختلف عن الذي أدخلته. أدخل العنوان كما هو مضبوط في ووردبريس تمامًا ثم أعد الاتصال.                                                                                                                               |
| `WOOCOMMERCE_WEBHOOK_SETUP_FAILED`     | Akeed could not finish setting up order notifications in your store. Nothing was connected. Try again.                                                                                                                                                              | تعذّر على أكيد إكمال إعداد إشعارات الطلبات في متجرك. لم يتم ربط أي شيء. حاول مرة أخرى.                                                                                                                                                   |
| `WOOCOMMERCE_STORE_UNAVAILABLE`        | This store is already connected to another Akeed account.                                                                                                                                                                                                           | هذا المتجر مرتبط بالفعل بحساب آخر في أكيد.                                                                                                                                                                                               |

Not refused at connect, because nothing at connect can show them: a custom gateway, a custom status, or a plugin that changes the order payload. Their orders are recorded as skipped with the reasons in section 4, and a store that depends on them is directed to support without a compatibility promise.

The other connect codes mirror the EasyOrders ones and need no new decision: `WOOCOMMERCE_CONNECT_UNAVAILABLE` (`404`), `WOOCOMMERCE_PILOT_REQUIRED` (`403`), `WOOCOMMERCE_SESSION_REQUIRED` (`403`), `WOOCOMMERCE_ROLE_REQUIRED` (`403`), `WOOCOMMERCE_SOURCE_EXISTS` (`409`), `WOOCOMMERCE_INSTALL_VALIDATION_FAILED` (`400`), `WOOCOMMERCE_INSTALL_CONTEXT_INVALID` (`401`), `WOOCOMMERCE_CALLBACK_INVALID` (`400`), `WOOCOMMERCE_PROVIDER_UNAVAILABLE` (`503`), `WOOCOMMERCE_RECONNECT_STORE_MISMATCH` (`409`), `WOOCOMMERCE_NOT_CONNECTED` (`404`), `WOOCOMMERCE_INGESTION_UNAVAILABLE` (`404`), `WOOCOMMERCE_WEBHOOK_UNAUTHORIZED` (`401`).

**Screen states the later stories must show** (Arabic and English, RTL and LTR; no key, secret, token or authorize link on screen; the store being connected is named by its canonical URL):

| State                | When                                                                                        | Story    |
| -------------------- | ------------------------------------------------------------------------------------------- | -------- |
| Enter store URL      | No source, organization on the allow-list                                                   | US-07-02 |
| Checking             | The start call is running                                                                   | US-07-02 |
| Waiting              | Back from the store with `success=1`, polling the connection status                         | US-07-02 |
| Denied               | Back with `success=0`. Offers to try again; says nothing was connected                      | US-07-02 |
| Unsupported store    | Any code in the table above, with its message                                               | US-07-02 |
| Error                | Install expired or invalid, provider unavailable, source exists, pilot required             | US-07-02 |
| Connected            | The source exists. Names the store                                                          | US-07-02 |
| Webhook disabled     | A webhook reads `disabled`. Offers re-enable; says orders placed meanwhile are not imported | US-07-05 |
| Credentials rejected | The last call got `401` or `403`. Offers reconnect                                          | US-07-05 |
| Disconnected         | After a disconnect. Shows the manual key-removal steps; offers reconnect                    | US-07-05 |

The not-completed and error screens tell the merchant that an unused key may be left in the store and where to revoke it.

## Adapter boundary

Provider names, statuses and payload shapes stay inside the spoke. No `woocommerce` branch is added to verification core, the hub, the queue processor or shared frontend logic.

**Spoke files**, under `src/infrastructure/spokes/woocommerce/`, each with its spec, modelled on the file of the same role in [`spokes/easyorders`](../../../../src/infrastructure/spokes/easyorders):

| File                                         | Role                                                               | Story                     |
| -------------------------------------------- | ------------------------------------------------------------------ | ------------------------- |
| `woocommerce.module.ts`                      | Controllers and the auth service                                   | US-07-02                  |
| `woocommerce-ingestion.module.ts`            | Providers the queue, outcome and onboarding modules import         | US-07-03                  |
| `woocommerce.errors.ts`                      | The codes above, their HTTP status and message                     | US-07-02                  |
| `woocommerce-store-url.ts`                   | Canonicalization and comparison of store URLs (pure)               | US-07-02                  |
| `woocommerce-install-token.ts`               | Token and reference generation, hashing, shape check               | US-07-02                  |
| `woocommerce-install-link.ts`                | Builds the authorize link                                          | US-07-02                  |
| `woocommerce-api.client.ts`                  | Every REST call, on the restricted client, returning coded results | US-07-02                  |
| `woocommerce-auth.service.ts`                | Start, callback, status, disconnect, reconnect, re-enable          | US-07-02, US-07-05        |
| `woocommerce-connection.controller.ts`       | Authenticated routes (start, status, disconnect, re-enable)        | US-07-02, US-07-05        |
| `woocommerce-install-callback.controller.ts` | The public callback                                                | US-07-02                  |
| `woocommerce-webhook.controller.ts`          | The public delivery route                                          | US-07-02 (ping), US-07-03 |
| `woocommerce-webhook.service.ts`             | The three-part check, routing and `ingest`                         | US-07-03                  |
| `woocommerce-ingestion.policy.ts`            | The start rule and skip reasons (pure)                             | US-07-03                  |
| `woocommerce-order.normalizer.ts`            | `WebhookOrderNormalizer`                                           | US-07-03                  |
| `woocommerce-order-eligibility.strategy.ts`  | `OrderEligibilityStrategy`                                         | US-07-03                  |
| `woocommerce-outcome.mapping.ts`             | Action to effect, writable statuses, marker (pure)                 | US-07-04                  |
| `woocommerce-outcome.adapter.ts`             | `CommerceOutcomeAdapter`, `tracksSynchronization: true`            | US-07-04                  |
| `woocommerce-order-update.handler.ts`        | `WebhookOrderUpdateHandler`                                        | US-07-04                  |
| `woocommerce-setup.contributor.ts`           | `SourceSetupContributor`                                           | US-07-05                  |
| `dto/woocommerce-connection.dto.ts`          | Request and response DTOs                                          | US-07-02                  |

Outside the spoke: `src/shared/config/woocommerce.config.ts`, `src/infrastructure/database/repositories/woocommerce-connections.repository.ts`, and the restricted client under `src/shared/http/`.

**Tables.** Spoke-owned, RLS on with no policy and table grants revoked, like the EasyOrders ones. The EasyOrders tables are not generalized.

| Table                          | Holds                                                                                                                                                                                                                                                                                                                             | Migration |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `woocommerce_pending_installs` | `org_id`, `created_by`, canonical `store_url`, `callback_token_hash` (unique), `install_reference` (unique), `webhook_token_hash` (unique), `expires_at`, `consumed_at`, `superseded_at`, `attempts`, `last_error_code`                                                                                                           | US-07-02  |
| `woocommerce_connections`      | `integration_id` (primary key, with `org_id` to `integrations`), canonical `store_url`, `store_verified_at`, the three ciphertexts, `webhook_token_hash` (unique), the two webhook ids, `health`, `rejected_deliveries`, `last_rejected_at`, `connected_by`, `connected_at`; a partial unique index on `store_url` where verified | US-07-02  |
| the same                       | `disconnected_at`, `disconnected_by`, and the check that a disconnected row holds no credential                                                                                                                                                                                                                                   | US-07-05  |

No new table for events (`webhook_events`) or outcomes (`commerce_outcome_syncs`). `woocommerce` is already in `SUPPORTED_PLATFORM_TYPES` and in the `platform_type` CHECK, so no constraint changes. Migrations are hand-written from `0051`, additive, each with its journal entry, and each added to the migration lists of the contract suites, as E06 did.

**Registration points:**

| What                  | Where                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Normalizer            | `WEBHOOK_ORDER_NORMALIZERS` in [`webhook-queue.module.ts`](../../../../src/modules/webhook-queue/webhook-queue.module.ts)                                                                               |
| Update handler        | `WEBHOOK_ORDER_UPDATE_HANDLERS`, the same file                                                                                                                                                          |
| Outcome adapter       | `COMMERCE_OUTCOME_ADAPTERS` in [`commerce-outcome.module.ts`](../../../../src/modules/commerce-outcomes/commerce-outcome.module.ts)                                                                     |
| Eligibility strategy  | `ORDER_ELIGIBILITY_STRATEGIES` in [`app.module.ts`](../../../../src/app.module.ts), which also imports the spoke module                                                                                 |
| Setup contributor     | `SOURCE_SETUP_CONTRIBUTORS` in [`onboarding.module.ts`](../../../../src/modules/onboarding/onboarding.module.ts)                                                                                        |
| Setup blocked reason  | A new `webhook_disabled` in `SOURCE_SETUP_BLOCKED_REASONS` in [`source-setup.ts`](../../../../src/shared/commerce/source-setup.ts). Existing reasons keep their names.                                  |
| Config                | `parseWooCommerceConfig` wired in [`env-validation.ts`](../../../../src/shared/config/env-validation.ts); `.env.example`; `docs/ENVIRONMENT.md`                                                         |
| Source-connect switch | `isSourceConnectEnabled` in [`easyorders.config.ts`](../../../../src/shared/config/easyorders.config.ts), read by `organizations.service.ts`. It reads only the EasyOrders switch today.                |
| Schema and repository | `schema.ts`, `database.module.ts`, `drizzle/`                                                                                                                                                           |
| Redaction             | `REDACTED_KEYS` in `backend-log.util.ts`                                                                                                                                                                |
| Signup picker         | `CONNECTABLE_SOURCES` in [`commerceSources.ts`](../../../../../akeed-frontend/src/shared/config/commerceSources.ts)                                                                                     |
| Onboarding skin       | `SKIN_BY_PLATFORM` and `CONNECT_SKIN` in [`useOnboardingSourceSkin.ts`](../../../../../akeed-frontend/src/features/onboarding/hooks/useOnboardingSourceSkin.ts), with a new `skins/woocommerce/` folder |
| Settings skin         | `SETTINGS_SOURCE_SKINS` in [`sourceSkins.ts`](../../../../../akeed-frontend/src/features/settings/domain/sourceSkins.ts)                                                                                |
| Order source label    | Already present: `woocommerce` is in `NAMED_ORDER_SOURCES` in `orderDisplay.ts`                                                                                                                         |

Not registered: no route-scoped CORS entry (the EasyOrders callback has one; this callback answers none), and no rate limiter.

**Two shared changes, each its own commit with the Shopify, Standalone and EasyOrders suites run before and after:**

1. The restricted outbound client under `src/shared/http/`, with its own spec.
2. `isSourceConnectEnabled` returns true when either connectable source is switched on.

**One point where the code needs more than a new row.** `CONNECT_SKIN` in `useOnboardingSourceSkin.ts` is the constant `'easyorders'`: an organization with no source always gets the EasyOrders connect skin. With two connectable sources the skin for a source-less organization has to come from the source chosen at signup (the `signup_source` user metadata `commerceSources.ts` already resolves). US-07-02 must make that change in the hook, not in JSX, and the EasyOrders tests must pass untouched.

**Switches.** All default to off.

| Switch                                    | Repo     | Off means                                                                                    |
| ----------------------------------------- | -------- | -------------------------------------------------------------------------------------------- |
| `WOOCOMMERCE_CONNECT_ENABLED`             | backend  | The start and callback routes answer `404`. Status, disconnect and health still work.        |
| `WOOCOMMERCE_PILOT_ORG_IDS`               | backend  | A populated list restricts installs to listed organizations; an empty list allows any organization while connect is enabled. |
| `WOOCOMMERCE_INGESTION_ENABLED`           | backend  | The delivery route answers `404` to order deliveries and `200` to a ping on a known token.   |
| `WOOCOMMERCE_OUTCOME_SYNC_ENABLED`        | backend  | The adapter has no capability. Nothing is sent to any store.                                 |
| `NEXT_PUBLIC_WOOCOMMERCE_CONNECT_ENABLED` | frontend | WooCommerce is not in the signup source picker.                                              |

The public base URLs of the API and the web app are needed for `callback_url`, `return_url` and the delivery URL. Whether WooCommerce reuses the EasyOrders variables or has its own is a US-07-02 decision; either way they are validated at boot when the connect switch is on.

**Entitlement.** A connected organization gets the pilot entitlement and onboarding defaults EasyOrders uses (`STANDALONE_DEFAULT_PLAN_ID`, billing not required). No billing work (PO, 2026-10-04, #6).

## Supported, unsupported, unknown

| Area                 | Supported (build on it)                                                                      | Unsupported                                                                      | Unknown (worst-case rule applies)                                                 |
| -------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Authorization        | `wc-auth/v1/authorize` with `read_write`; token in the callback path; reference in `user_id` | Manual key entry; a `state` parameter; trusting `return_url`                     | Callback origin and headers; `user_id` round trip; what a refused callback leaves |
| Credentials          | Basic authentication over HTTPS; proof by system status                                      | Query-string credentials; OAuth 1.0a; plain HTTP                                 | Status and code for a stripped header, a revoked key and a missing permission     |
| Store identity       | Canonical store URL equal to the store's `home_url`; one store, one organization             | IP literals, custom ports, redirects; a second organization on the same store    | How `home_url` and `site_url` differ                                              |
| Webhook authenticity | URL token, raw-body HMAC-SHA256 with an Akeed secret, source header                          | A default or merchant-chosen secret; the delivery id as proof                    | The exact `X-WC-Webhook-Source` value                                             |
| Delivery             | `2xx` after the row is written; semantic keys; ping answered `200`                           | Backfill of missed orders; polling                                               | Ping body; timeout; retry; ordering; whether re-enabling resets the count         |
| Disabling            | Read by REST, re-enabled by REST                                                             | Background monitoring                                                            | The real threshold on a store (it is filterable)                                  |
| Order data           | `id`, `number`, billing name, phone and country, `total`, `currency`, `payment_method`       | Custom gateways; custom statuses; shipping phone; order lookups on ingest        | The draft status value; the status of a placed COD order on each checkout         |
| Outcomes             | Confirm: marker and note. Cancel: `cancelled` and marker, from `processing` or `on-hold`     | Automatic no-reply cancel; tags; paid, completed, refunds; per-merchant mappings | Duplicate meta keys; cancellation emails; transition rules; the echo              |
| Tenant resolution    | Per-install URL token by hash; `woocommerce:<orgId>` source identity                         | Tenant from the payload or a header                                              | —                                                                                 |
| Secrets              | Ciphertext for keys and webhook secret; hashes for tokens; manual key removal                | A key or secret in a URL, log, response or fixture                               | Whether a key can be removed by REST                                              |
| Limits               | 10-second calls, 1 MiB responses, `Retry-After` honored, no budget                           | `_method` overrides; following redirects                                         | Host and firewall throttling; WooCommerce's wait on the callback                  |

## Observations for US-07-06

Each observation is made on a real store during the live run and turns the listed findings into VERIFIED. A result that contradicts this record opens one focused validation story and reopens only the affected story.

| #   | Observe                                                                                                                                                                        | Closes          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| 1   | The install callback: who sends it (store server or browser), its headers and content type, the type of `user_id`, and whether a refused callback leaves a key in the store    | 1.8, 1.12, 1.13 |
| 2   | The ping: when it arrives relative to the webhook creation, its body, content type and headers, and whether it is signed                                                       | 3.9, 3.10       |
| 3   | A COD order placed on **classic checkout**: its `status` and `payment_method`, which topics fire and in which order                                                            | 4.9, 4.12, 3.18 |
| 4   | A COD order placed on the **Checkout block**: the same, plus whether a draft delivery comes first and what its `status` value is                                               | 3.6 to 3.8, 4.7 |
| 5   | Writing `cancelled` through REST from `processing` and from `on-hold`: stock, emails to the customer and the merchant, notes WooCommerce adds                                  | 5.9 to 5.11     |
| 6   | Whether the confirmation write (meta only) and the cancellation write each come back as `order.updated`, what the echo carries, and whether the marker is duplicated on repeat | 5.3, 5.12       |
| 7   | API-key removal: that it is manual in the admin screen, and the status and `code` Akeed's next call gets after the key is revoked                                              | 2.6, 7.4, 7.5   |
| 8   | The exact `X-WC-Webhook-Source` value against the canonical store URL and `environment.home_url`, on a store at a domain root and, if one is available, in a subdirectory      | 2.9, 2.15, 2.16 |

## Verdict

The epic's rule is that an UNKNOWN on authenticity, tenant resolution or secret handling blocks. Checked against that rule:

- **Authenticity.** The signature is documented (2.12): a base64 HMAC-SHA256 of the request body with a secret that Akeed sets and that the API never returns (2.10). No UNKNOWN weakens it. The UNKNOWNs near it (2.16, the source header's exact value; 3.10, the ping) cannot make Akeed accept anything: the source check only ever refuses, and a ping stores nothing and changes nothing. The callback has no documented sender authentication (1.11, 1.12); that is not left open, it is closed by design: the path token binds the organization, and the keys must work on the store URL held in the install context.
- **Tenant resolution.** Akeed's own mechanism (section 6), resting on one documented fact: a webhook delivers to the URL it was created with (6.1). No UNKNOWN.
- **Secret handling.** The path of every secret is documented or decided (section 7). The one UNKNOWN (7.5, removing a key through REST) has a rule that needs nothing from WooCommerce: the merchant removes it by hand.

No blocking UNKNOWN remains.

| Story                              | Verdict                                                                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| US-07-02 Connect                   | **Unblocked.** Build to sections 1, 2, 6, 7 and 8 and the support boundary, behind `WOOCOMMERCE_CONNECT_ENABLED` and the allow-list.                   |
| US-07-03 Ingestion                 | **Unblocked.** Build to sections 2, 3, 4 and 6, behind `WOOCOMMERCE_INGESTION_ENABLED`.                                                                |
| US-07-04 Outcomes                  | **Unblocked to build.** Remote writes stay off for every merchant until observations 5 and 6 are made and the product owner has seen the real effects. |
| US-07-05 Setup, health, disconnect | **Unblocked.** Build to sections 3 and 7.                                                                                                              |
| US-07-06 Gate and pilot            | **Unblocked.** It owns the eight observations. No real merchant is enabled before it.                                                                  |

Four choices in this record are labelled "DECIDED (record)" and are the product owner's to confirm or change on review: the placed statuses (4.12), the statuses an outcome may be written from (5.16), the marker (5.17) and the note (5.18). Changing any of them changes this record first, then the code.

## Documentation discrepancies

Found while reading. None blocks; each is handled by a rule above.

- **What counts as a failed delivery.** S2 says "a non HTTP 2xx response code". S3 and S9 count `301` and `302` as success. Akeed answers `2xx` or a real refusal, never `3xx`.
- **How many failures disable a webhook.** S2: "After 5 consecutive failed deliveries". S3: "after 5 retries by default". S9: "after more than five consecutive delivery failures". Akeed assumes the fifth.
- **The default webhook secret.** S2: "a MD5 hash from the current user's ID|username". S3 and S9: "the current API user's consumer secret". Akeed always sends its own secret, so neither default applies.
- **`delivery_url` is marked READ-ONLY** in the S2 property table, and every create example sets it.
- **Issue #37958 is closed.** The story called it open when it was written; GitHub shows it closed as completed on 2026-09-25. S10 describes the new behavior without naming a version, so older stores must still be assumed to send a draft delivery.
- **The draft status is in the merchant docs (S10) and not among the REST `status` options (S5).**

## Amendments

### 2026-10-04, US-07-02 build (product owner)

Three points the record did not settle, decided while building the connect flow. Recorded in the [US-07-02 evidence](../../../US-07-02-WOOCOMMERCE-CONNECTION-EVIDENCE.md).

1. **The start probe.** The Detection paragraph under "Support boundary" and the unsupported-cases table disagreed on a `5xx` and a body that is not JSON at start. Decided: at start a `5xx` is refused as `WOOCOMMERCE_REST_UNREACHABLE` and the body is never read. The table's "body that is not JSON" applies to the callback's authenticated read only.
2. **One callback at a time per install.** The webhooks are replaced outside any transaction (section 2), so two callbacks on one link at the same moment could delete each other's webhooks. `woocommerce_pending_installs` gains `claimed_until`: a callback claims the install for 45 seconds before any store call, a concurrent one gets `WOOCOMMERCE_INSTALL_CONTEXT_INVALID` without counting an attempt, and every refusal releases the claim.
3. **When the webhook URL token is generated.** Section 6 said "generated when the install starts" and section 7 "stored only as a SHA-256 hash", but the callback has to put the token itself into the delivery URL. Decided: the token is generated in the callback from the CSPRNG, and its hash is written to the pending install just before the webhooks are created, so the ping still finds a known token (section 3). It stays hash-only at rest and independent of the callback token. `webhook_token_hash` on a pending install is NULL until then, and a retried callback issues a fresh token.

### 2026-10-04, US-07-03 build (product owner)

Two points the record did not settle, decided while building ingestion. Recorded in the [US-07-03 evidence](../../../US-07-03-WOOCOMMERCE-INGESTION-EVIDENCE.md).

1. **What an event row keeps.** The mapping table in section 4 says `rawPayload` is "the delivered object"; the story asks for the delivery identifiers and only the payload needed. Decided: `webhook_events.raw_payload` is `{ topic, webhookId, deliveryId, order }`, and `order` holds only the fields section 4 reads (`id`, `number`, `status`, `currency`, `date_created_gmt`, `date_modified_gmt`, `total`, `payment_method`, and the billing first name, last name, phone and country) plus the `meta_data` entries whose key is `akeed_outcome`, which the echo rule in section 5 needs. `NormalizedOrder.rawPayload` is the same projection. The customer's email, addresses and IP address, the line items and other plugins' meta are not stored.
2. **An inactive source with a live token.** The answer table in section 3 has no row for it. Decided: the delivery is authenticated, recorded and answered `200`; the processor marks the event `integration_inactive` and nothing is sent. It is not refused, because a non-`2xx` answer counts toward the store disabling the webhook (3.11). A disconnect wipes the token, and that stays a `401`.

Clarified in the same build, within the rules above:

- **Section 3, "a repeat of an event already stored".** A repeat is "nothing new" when its key is already stored. By the routing rule in section 4, a repeat of a placed order that Akeed already has a create event for is an update, so the first such repeat is recorded once under its `order.update` key and later repeats in the same state store nothing. One order and one verification in every case.
- **Section 4, the age rule.** `date_created_gmt` has no fraction (4.4), so the connection moment is floored to the second before comparing.
- **Section 4, the update and skip keys.** `status` and `date_modified_gmt` are store text. Each is used in a key only when it is 1 to 64 printable ASCII characters without spaces; otherwise the key holds the literal `invalid`.
- **Section 2, part two of the check.** A stored secret that cannot be decrypted, or that is not in the `v1:` envelope, fails the check: `401`, counted. A stored value is never used as an HMAC key itself.

### 2026-10-04, US-07-04 build (product owner)

Three points the record did not settle, decided while building outcome writes. Recorded in the [US-07-04 evidence](../../../US-07-04-WOOCOMMERCE-OUTCOME-SYNC-EVIDENCE.md).

1. **The echo rule.** Section 5 called an update `reflected_outcome` whenever its `meta_data` held the marker of a recorded outcome. The marker stays on the order, so every later change by the merchant would have been called a reflection, against US-07-04 AC 7. Decided: an update is `reflected_outcome` when it holds such a marker **and** its status is one that write could have left: `cancelled` for a cancellation, `processing` or `on-hold` for a confirmation. Anything else is `remote_status_observed`. A waiting or failed row still counts. Neither result changes a verification, writes to the store or starts a verification.
2. **The confirmation note (5.18).** The text is fixed and bilingual: `Akeed: order confirmed. / أكيد: تم تأكيد الطلب.`, with `customer_note: false`. It does not say who confirmed, because a merchant's confirmation in Akeed is the same action as the customer's reply.
3. **A `405` or `501` on a write (8.4).** The failure table in section 5 had no row for it. Decided: `permanent_failure` / `store_write_method_refused`, `requiresAssistance`. Health is not changed: the keys were accepted.

Clarified in the same build, within the rules above:

- **Section 5, step 1, "this store's order".** `_links.self[0].href` must be exactly `<canonical store URL>/wp-json/wc/v3/orders/<id>` once the part before `/wp-json/` is canonicalized by the rules of section 2. "Lies under" is read as equality, so a store at a domain root does not take the answer of a store in a subdirectory of it.
- **Section 5, the decision table.** A cancellation whose marker is on an order that is not `cancelled` is `remote_state_conflict`, not a write: the cancellation was taken and the merchant reopened the order. A status that is missing or is not 1 to 64 printable ASCII characters without spaces is a conflict with no `providerStatus`.
- **Section 5, step 5, the read-back.** It uses the decision table of step 2, so a cancellation read back as `cancelled` is `applied` with or without the marker. For a confirmation whose first read showed no marker, the note is added once the read-back shows the marker, in that same run.
- **Section 5, the failure table.** `429` is `source_rate_limited` and `503` is `source_unavailable`; both are retryable on a read and on a write, without a read-back, because every retry starts with a read. A `4xx` on the write other than those named is `remote_rejected`. An oversized answer to a write is ambiguous and is read back; to a read it is `store_unreachable`. `403` sets the health to `permission_denied`, and a successful read sets it back to `ok`.
- **Section 8, `Retry-After`.** Seconds or an HTTP date, non-negative, passed on as it is. The existing policy clamps it to 10 minutes.

### 2026-10-05, US-07-05 build (product owner)

Three points decided while building setup, health and disconnect. Recorded in the [US-07-05 evidence](../../../US-07-05-WOOCOMMERCE-SETUP-HEALTH-EVIDENCE.md) and the [runbook](US-07-05-disconnect-and-support-runbook.md).

1. **The order of a disconnect (section 7).** The Disconnect bullet says Akeed deletes its two webhooks "while it still holds the keys" and "then" wipes. Decided: the local half runs first. One transaction deactivates the source and wipes the ciphertexts, the token hash, the webhook ids and the verified-store slot. The keys that transaction read are decrypted in memory for that request only and used to delete the two webhooks, best effort, within 15 seconds. A failure is reported in the answer (`webhookCleanup: failed`) and does not undo the disconnect. So nothing new can start while Akeed waits on a merchant's store, and no row is ever half-disconnected. If the process dies between the two steps no deletion is tried and none is reported; the leftover webhooks answer `401` and disable themselves, which section 3 already names as the intended end state when the deletion fails.
2. **Re-enabling needs ingestion on.** The story names no switch for it. Decided: `WOOCOMMERCE_INGESTION_ENABLED` must be on, otherwise `503 WOOCOMMERCE_WEBHOOK_ENABLE_UNAVAILABLE` with no request to the store. A webhook re-enabled while order deliveries answer `404` would be disabled again on its next order (3.11, 3.17). It needs neither the connect switch nor the pilot list.
3. **The setup, checklist and disconnect screens are shared.** The EasyOrders setup flow, checklist card and disconnect dialog were extracted to source-neutral components; each skin supplies its own rows and words. No provider behavior moved.

Clarified in the same build, within the rules above:

- **Section 3, "shown in health and as a setup blocked reason".** The store is read only when health is read, when the connection is checked and before a re-enable, as the section says. What was read is stored on the connection row as the last state, and the setup blocked reason `webhook_disabled` comes from that stored state. Reading setup or settings never calls a store: both are read on every route.
- **Section 3, the three states.** `disabled` is the only one that blocks setup. `paused` is shown and never overridden. A `404` on a webhook is `missing`; a status that is none of the three is `unknown`, as is a store that could not be asked. Only a definite state replaces the stored one.
- **Sections 2 and 5, `401` and `403`.** Both show as rejected credentials and both block setup as `credentials_rejected`; the connection status keeps `permission_denied` apart for its own guidance. An answer that needed the keys to be given, including a `404` for one webhook, sets the health back to `ok`.
- **The connection check.** In order: `system_status` (address, TLS, REST, keys, permission, and `environment.home_url` still equal to the canonical store URL), then both webhooks. It answers `200` with the codes it found: the support-boundary codes, plus `WOOCOMMERCE_WEBHOOK_MISSING`, `WOOCOMMERCE_WEBHOOK_DISABLED` and `WOOCOMMERCE_WEBHOOK_PAUSED`. A health read sends two requests under an 8-second budget; a check or a re-enable works under 20 seconds.
- **Section 2, reconnect.** The same canonical store URL is required at the start, before the discovery probe, so a disconnected organization cannot make Akeed call another host; it is checked again in the transaction. `connected_at` moves to the reconnect, so an order placed while disconnected is `order_predates_connection` (section 4).
- **A re-enable that the host refuses (8.4).** `405` or `501` on the `PUT` is `WOOCOMMERCE_WEBHOOK_ENABLE_FAILED`. A webhook that still reads `disabled` after a `2xx` is the same code: success is what the store shows.
