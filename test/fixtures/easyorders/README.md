# EasyOrders fixtures

Webhook payloads for the EasyOrders spoke (E06).

| File                       | Event               | Source                         |
| -------------------------- | ------------------- | ------------------------------ |
| `order-created.json`       | Order created       | Documented shape, not captured |
| `order-status-update.json` | Order status change | Documented shape, not captured |

Each file has a `_fixture` block describing where it came from and a `payload` block holding the webhook body.

These two were built from the public webhook docs (read 2026-10-03) because the US-06-01 test store was inactive and delivered no webhooks. Every ID, customer field, product name and timestamp is synthetic. Replace them with sanitized captures after the go-live verification run described in the [contract record](../../../docs/Epics/06-easyorders-integration/evidence/US-06-01-contract-record.md):

```powershell
node scripts/spikes/easyorders/sanitize-fixture.mjs --seq <n> --out test/fixtures/easyorders/order-created.json
```

Never put a real customer value, API key, webhook secret or webhook URL token in this folder.
