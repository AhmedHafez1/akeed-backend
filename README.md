# Akeed Backend

Multi-tenant NestJS backend for automating Cash on Delivery (COD) order verification for e-commerce platforms. Currently supports Shopify with WhatsApp Cloud API for customer verification.

## Overview

- Hub-and-Spoke architecture: Core verification hub with platform spokes (Shopify, WhatsApp).
- Real-time order ingestion via Shopify webhooks and WhatsApp interactive messaging.
- Multi-tenant data isolation per organization.

## Quick Start

```bash
npm install

# Development
npm run start:dev

# Production
npm run build
npm run start:prod
```

## Key Endpoints

- Shopify OAuth:
  - `GET /auth/shopify?shop={domain}`
  - `GET /auth/shopify/callback`
- Shopify Webhooks:
  - `POST /webhooks/shopify/orders-create`
  - `POST /webhooks/shopify/uninstalled`
- WhatsApp Webhooks:
  - `POST /webhooks/whatsapp`

## Shopify Webhook Registration

- Topics: `orders/create`, `app/uninstalled`
- Versioned Admin API: `POST https://{shop}/admin/api/{version}/webhooks.json`
- Header: `X-Shopify-Access-Token`
- Idempotent: HTTP 422 (already exists) treated as success; safe on reinstall
- Non-blocking OAuth callback: registration runs in the background
- Retry with backoff; logs include topic and shop

## Environment

Configure environment variables (see detailed guidance in [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md)):

```
APP_URL=...
API_URL=...
DATABASE_URL=...

# Shopify
SHOPIFY_API_KEY=...
SHOPIFY_API_SECRET=...
SHOPIFY_SCOPES=read_orders,write_orders
SHOPIFY_API_VERSION=2026-01

# WhatsApp (Meta)
WA_PHONE_NUMBER_ID=...
WA_BUSINESS_ACCOUNT_ID=...
WA_ACCESS_TOKEN=...
WA_VERIFY_TOKEN=...
```

## Documentation

- Architecture and agent context: [docs/ARCHITECTURE_AGENT_CONTEXT.md](docs/ARCHITECTURE_AGENT_CONTEXT.md)
- Business overview and capabilities: [docs/BUSINESS.md](docs/BUSINESS.md)
- Database setup and schema: [docs/DATABASE.md](docs/DATABASE.md)
- Environment management: [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md)

## Code Pointers

- Shopify Orders Controller: [src/infrastructure/spokes/shopify/shopify.controller.ts](src/infrastructure/spokes/shopify/shopify.controller.ts)
- Shopify Auth Controller: [src/infrastructure/spokes/shopify/shopify-auth.controller.ts](src/infrastructure/spokes/shopify/shopify-auth.controller.ts)
- Shopify Auth Service: [src/infrastructure/spokes/shopify/services/shopify-auth.service.ts](src/infrastructure/spokes/shopify/services/shopify-auth.service.ts)
- Verification Hub: [src/core/services/verification-hub.service.ts](src/core/services/verification-hub.service.ts)
