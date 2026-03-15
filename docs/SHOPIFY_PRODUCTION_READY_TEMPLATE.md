# Shopify Production Configuration Template

## 1) Mandatory GDPR Compliance Webhooks

Declare all three mandatory topics in `shopify.app.toml`:

```toml
[webhooks]
api_version = "2026-01"

[[webhooks.subscriptions]]
topics = ["customers/data_request"]
uri = "/webhooks/shopify/customers/data_request"

[[webhooks.subscriptions]]
topics = ["customers/redact"]
uri = "/webhooks/shopify/customers/redact"

[[webhooks.subscriptions]]
topics = ["shop/redact"]
uri = "/webhooks/shopify/shop/redact"
```

## 4) Post-Deploy Smoke Checklist

- Install app on a test store from production app listing.
- Verify OAuth callback completes and app opens embedded in admin.
- Confirm `customers/data_request` webhook endpoint returns `200` for valid signed requests.
- Confirm `customers/redact` webhook endpoint returns `200` for valid signed requests.
- Confirm `shop/redact` webhook endpoint returns `200` for valid signed requests.
- Confirm `orders/create` webhook still processes and creates verification jobs.
