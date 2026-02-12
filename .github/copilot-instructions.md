# Akeed – Copilot Instructions

## Coding Standards

- Keep changes minimal and focused; avoid unrelated refactors.
- Match existing style and naming; use descriptive variables.
- Do not add license/copyright headers unless explicitly requested.
- Avoid inline comments in code unless the user requests them.
- Prefer strong typing; avoid `any`.
- Handle errors gracefully; log context (e.g., topic+shop for Shopify).

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

## Comment

- Please generate md documet that explain app archeticture all features in the way that help agents understand app context.
- You are building the onboarding flow for the Shopify Empedded App called:

This app automatically verifies Cash on Delivery (COD) orders using a centralized WhatsApp Business API number owned by the platform (not the merchant).

Merchants do NOT connect their own WhatsApp number.

The onboarding must be extremely frictionless and take less than 2 minutes to complete.

The goal is to:

Secure billing before activation

Prevent message abuse

Keep configuration minimal

Ensure clean UX

1️⃣ OVERALL FLOW STRUCTURE

After Shopify OAuth is completed:

Redirect merchant to:

/onboarding

The onboarding flow must include the following steps:

Welcome Screen

Basic Configuration

Billing Activation (Mandatory)

Activation Confirmation

The merchant must NOT be allowed to activate auto-verification without selecting a billing plan.

2️⃣ STEP 1 — WELCOME SCREEN
UI Content

Title:
"Reduce Fake COD Orders with WhatsApp Verification"

Description:
"Automatically send WhatsApp messages to customers to confirm Cash on Delivery orders and reduce returns."

CTA Button:
→ Start Setup

Secondary option (if makes sense):
Small text link: "Skip for now" (but this keeps verification disabled)
