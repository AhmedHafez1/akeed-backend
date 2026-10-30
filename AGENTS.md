# AGENTS.md — Akeed Backend

Guidelines for AI coding agents operating in this repository.

## Shared workspace skills

Read the parent [AGENTS.md](../AGENTS.md) and [CLAUDE.md](../CLAUDE.md) for shared product context and constraints. Before backend edits, load [backend-dev](../.agents/skills/backend-dev/SKILL.md); its maintained implementation is shared with Claude. Load the database, localization, or design skills from that parent guide when relevant. If this repository is checked out alone, report missing shared resources rather than inventing their contents.

Preserve CRLF and existing user edits. Format only touched files, with `--end-of-line crlf`; do not reformat hand-written Markdown docs. Inspect the current branch; commit only when requested and never on `main`.

This file includes Copilot instructions from `.github/copilot-instructions.md`.

## Build / Lint / Format / Test / Dev

```bash
npm run start:dev      # Start NestJS dev server (watch mode)
npm run build          # Build (nest build)
npm run start:prod     # Run production server (dist/src/main)
npx eslint <files>     # Check touched files; npm run lint fixes the whole tree
npx prettier --check --end-of-line crlf <files> # Check touched code only
npm run test           # Jest unit tests
npm run test:watch     # Jest watch mode
npm run test:cov       # Jest with coverage
npm run test:debug     # Jest debug (node --inspect-brk)
npm run test:e2e       # Jest e2e (test/jest-e2e.json)
```

### Running a Single Test

```bash
npx jest src/modules/verification-automation/verification-automation.producer.spec.ts
npm run test -- -t "test name"
npm run test:e2e -- -t "test name"
```

## Database / Drizzle

```bash
npm run db:pull         # Introspect DB into schema
# db:push and db:generate are unusable here (see below).
# Do not run db:migrate against a shared database.
npm run db:studio       # Open Drizzle Studio
```

Drizzle config: `drizzle.config.ts` (uses `DATABASE_URL` from `.env` or `.env.{NODE_ENV}`).

Do not use `db:generate` or `db:push`: the `drizzle/meta` snapshots stop at
migration 0015, so generate diffs against a stale baseline, and push must never
target a shared database. Write migrations by hand as the next numbered
`drizzle/NNNN_name.sql` plus a `drizzle/meta/_journal.json` entry; they run at
boot via `runMigrations()` in `main.ts`.

## Architecture Conventions

- Use async/await
- Prefer services over controllers
- Never put business logic in controllers
- Use the existing Shopify Admin GraphQL API for order outcomes, store metadata, and billing; keep commerce outcomes behind the trusted integration adapter registry
- Validate HMAC for all Shopify callbacks
- Assume raw body is required for webhooks

## Security Requirements

- Always verify Shopify HMAC
- Use timing-safe comparisons
- Never log secrets or tokens

## Code Style Guidelines

### General

- Keep changes minimal and focused; avoid unrelated refactors
- Match existing style and naming; use descriptive variables
- Do not add license/copyright headers unless explicitly requested
- Comment non-obvious constraints or decisions; avoid narrating the code
- Avoid one-letter variable names unless explicitly requested
- Do not change filenames or public APIs unless required by the task
- Update documentation when behavior or interfaces change

### TypeScript

- TypeScript strict
- Prefer strong typing; avoid `any`
- Clear method names

### Formatting

- Consistent formatting (Prettier)
- ESLint runs with `--fix` by default in `npm run lint`

### Error Handling

- Use stable coded HTTP errors and structured redacted `buildBackendLog` context; run `npm run log:check`
- Production-grade error handling

### Dependencies

- Avoid unnecessary dependencies

## Tests

- Unit tests: Jest (`testRegex: .*\.spec\.ts$` in `src/`)
- E2E tests: Jest with `test/jest-e2e.json` (`.e2e-spec.ts`)
- Use `npm run test -- <path>` to run a single spec file

## Documentation Pointers

- Environment guide (every env var): `docs/ENVIRONMENT.md`
- Domain guides: `docs/ORDER_CONFIRMATION_WORKFLOW.md`, `docs/ONBOARDING_AND_BILLING.md`, `docs/INTEGRATIONS_WEBHOOKS_AND_AUTOMATION.md`, `docs/IDENTITY_ACCESS_AND_ORGANIZATION.md`, and the other `docs/*.md` files
- Billing runbooks: `docs/STANDALONE_BILLING_OPERATIONS_RUNBOOK.md`, `docs/STANDALONE_BILLING_SANDBOX_PLAYBOOK.md`
- Support runbooks: `docs/EASYORDERS_SUPPORT_RUNBOOK.md`, `docs/WOOCOMMERCE_SUPPORT_RUNBOOK.md`, `docs/WHATSAPP_TEMPLATE_SUPPORT_RUNBOOK.md`
- Database: schema in `src/infrastructure/database/schema.ts`; hand-written migrations in `drizzle/`

## Response & Formatting Guidance for Agents

- Be concise, direct, and friendly; focus on actionable steps
- Use short section headers where helpful; bullets for scannability
- Wrap commands in fenced code blocks and keep them copyable
- Use KaTeX for math when needed
