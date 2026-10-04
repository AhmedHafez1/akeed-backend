# WooCommerce fixtures

Webhook bodies for the WooCommerce spoke (E07). **Documented, not captured:** no request was sent to any store to make them.

| File                        | Delivery                                         | Source                                        |
| --------------------------- | ------------------------------------------------ | --------------------------------------------- |
| `order-checkout-draft.json` | `order.created` for a checkout draft             | Documented shape; the status value is assumed |
| `order-placed-cod.json`     | `order.created` for a placed COD order           | Documented shape, not captured                |
| `order-placed-non-cod.json` | `order.created` for a placed bank-transfer order | Documented shape, not captured                |
| `order-updated.json`        | `order.updated` after a change made in the store | Documented shape, not captured                |
| `ping.txt`                  | The ping sent when a webhook is first activated  | **Assumed, not documented**                   |

Each JSON file has a `_fixture` block saying where it came from and which delivery headers go with it, and a `payload` block holding the webhook body. The body is the order object of the [REST orders reference](https://developer.woocommerce.com/docs/apis/rest-api/v3/orders/), which the [webhooks reference](https://developer.woocommerce.com/docs/apis/rest-api/v3/webhooks/) says a delivery repeats exactly. Both pages were read on 2026-10-04. Every ID, customer field, product name and timestamp is synthetic, and `example.com` is the store.

How the files fit together:

- `order-checkout-draft.json`, `order-placed-cod.json` and `order-updated.json` are the same order (`id` 1001) at three moments: draft, placed, then completed by the merchant. Draft then placed must give one verification.
- `order-placed-non-cod.json` is another order (`id` 1002) and must start nothing.
- To test `order.created` and `order.updated` arriving together, send `order-placed-cod.json` twice and change only the topic headers.

What is not in them, on purpose:

- **No `X-WC-Webhook-Signature`.** A test computes the base64 HMAC-SHA256 over the exact bytes it sends, with a secret it generates.
- **No consumer key, consumer secret, webhook secret or URL token.** Never put one in this folder, and never a real customer value.

Two parts are assumptions, because the documentation is silent (see the [contract record](../../../docs/Epics/07-woocommerce-integration/evidence/US-07-01-contract-record.md), findings 3.10 and 4.7):

- **The ping.** No page documents its body, content type or headers. `ping.txt` holds a form-encoded body (`application/x-www-form-urlencoded`) as a placeholder; trim the trailing line break before use. The ping rule in the record does not read the body, so a test should also pass with any other body.
- **The draft status value.** The REST reference lists no draft status. `checkout-draft` in `order-checkout-draft.json` is a placeholder; any status other than `processing` or `on-hold` is skipped the same way.

Replace all five with sanitized captures after the US-07-06 live run.
