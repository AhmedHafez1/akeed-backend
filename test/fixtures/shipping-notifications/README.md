# Shipping notification fixtures

Synthetic Shopify `orders/updated` payloads for the shipping-notifications replay.

| File | Describes |
| --- | --- |
| `orders-updated/fulfilled-with-tracking.json` | Fulfilled with a tracking number and an https link |
| `orders-updated/fulfilled-without-tracking.json` | Fulfilled with no tracking, and an http link that is ignored |
| `orders-updated/fulfilled-then-tagged.json` | The fulfilled order after a mapped Arabic tag is added |
| `orders-updated/tagged-only.json` | Not fulfilled, with a mapped Arabic tag and surrounding spaces |
| `orders-updated/unfulfilled-untagged.json` | An ordinary edit with no shipping signal |
| `orders-updated/akeed-tag-echo.json` | The update that follows Akeed's own tag writes |
| `orders-updated/cancelled-in-shopify.json` | Fulfilled, then cancelled in Shopify |
| `orders-updated/scenarios.json` | The replay scenarios: deliveries in arrival order, store settings and expected results |

The payloads follow the documented Shopify 2026-01 order shape, projected to the fields shipping reads. They were not captured from a store, and they hold no customer, address or store data. Dates are placeholders that `load-orders-updated.ts` fills relative to the run, so a fixture never ages past the 30-day rule.

Two specs replay them:

- `src/infrastructure/spokes/shopify/services/shopify-orders-updated.replay.spec.ts` covers the webhook intake: the env switch, the store switch, the delivery-id dedupe and the projection.
- The `orders/updated replay fixtures` block in `test/shipping-notifications.contract-spec.ts` covers processing against PostgreSQL.

Never put a real order, customer value or webhook secret in this folder.
