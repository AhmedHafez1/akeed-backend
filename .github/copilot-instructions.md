# Akeed – Copilot Instructions

These instructions guide AI assistants working on this repository to produce safe, precise, and useful changes.

## Project Overview

- Multi-tenant NestJS backend that automates COD order verification for e-commerce (Shopify) using WhatsApp Cloud API.
- Hub-and-Spoke architecture:
  - Core: `VerificationHubService` orchestrates verification and messaging.
  - Spokes: Platform adapters (Shopify, Meta/WhatsApp).
- Key docs:
  - Business overview: [docs/BUSINESS.md](../docs/BUSINESS.md)
  - Environment configuration: [docs/ENVIRONMENT.md](../docs/ENVIRONMENT.md)
  - Database setup: [docs/DATABASE.md](../docs/DATABASE.md)

## Tech Stack

- Framework: NestJS (TypeScript).
- Database: PostgreSQL via Drizzle ORM.

## Development Workflow

- Install & run:
  - `npm install`
  - Dev: `npm run start:dev`
  - Prod: `npm run build` then `npm run start:prod`
- Database workflows:
  - `npm run db:push` (dev), `npm run db:generate`, `npm run db:migrate`, `npm run db:studio`
- Testing & linting:
  - Unit: `npm run test` | E2E: `npm run test:e2e` | Coverage: `npm run test:cov`
  - Lint/format: `npm run lint` | `npm run format`

## Coding Standards

- Keep changes minimal and focused; avoid unrelated refactors.
- Match existing style and naming; use descriptive variables.
- Do not add license/copyright headers unless explicitly requested.
- Avoid inline comments in code unless the user requests them.
- Prefer strong typing; avoid `any`.
- Handle errors gracefully; log context (e.g., topic+shop for Shopify).

## Shopify Requirements (Important)

- Webhook registration:
  - Topics: `orders/create`, `app/uninstalled`.
  - Use `POST https://{shop}/admin/api/{version}/webhooks.json` with `X-Shopify-Access-Token`.
  - Idempotent: treat HTTP 422 "already exists" as success; safe on reinstall.
  - Non-blocking: do not delay OAuth callback; run registration in background.
  - Reliability: retry with backoff; log failures including topic + shop.
- Order normalization fields include: `orgId`, `integrationId`, `externalOrderId`, `orderNumber`, `customerPhone`, `customerName`, `totalPrice`, `currency`, `rawPayload`.

## Editing Rules (for file changes)

- Make surgical edits using the editor tools; preserve indentation and formatting.
- Fix problems at the root cause; don’t apply superficial patches.
- Do not change filenames or public APIs unless required by the task.
- Avoid one-letter variable names unless explicitly requested.
- Update documentation when behavior or interfaces change.

## Response & Formatting Guidelines

- Be concise, direct, and friendly; focus on actionable steps.
- Use short section headers where helpful; bullets for scannability.
- Link files using workspace-relative markdown links:
  - File: [src/infrastructure/spokes/shopify/shopify.controller.ts](../src/infrastructure/spokes/shopify/shopify.controller.ts)
  - Include lines/ranges when helpful; ensure links point to existing files.
- Wrap commands in fenced code blocks and keep them copyable.
- Use KaTeX for math when needed.

## Conventions:

- Use async/await
- Prefer services over controllers
- Never put business logic in controllers
- Use Shopify Admin REST API
- Validate HMAC for all Shopify callbacks
- Assume raw body is required for webhooks

## Security:

- Always verify Shopify HMAC
- Use timing-safe comparisons
- Never log secrets or tokens

## Code style:

- TypeScript strict
- Clear method names
- Production-grade error handling

## Helpful Links

- README: [README.md](../README.md)
- Business docs: [docs/BUSINESS.md](../docs/BUSINESS.md)
- Environment guide: [docs/ENVIRONMENT.md](../docs/ENVIRONMENT.md)
- Database guide: [docs/DATABASE.md](../docs/DATABASE.md)
