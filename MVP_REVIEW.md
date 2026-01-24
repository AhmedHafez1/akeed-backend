# Akeed Backend - MVP Review

## 1. Current App Capabilities

The current codebase implements the core "Happy Path" for verifying Shopify COD orders via WhatsApp.

### ✅ Authentication & Onboarding

### ✅ Order Ingestion (Shopify Spoke)

- **Webhook Handling**: Accepts `orders/create` webhooks from Shopify.
- **Data Mapping**: Normalizes Shopify order data into a standard internal structure (`NormalizedOrder`).
- **Idempotency**: Checks if the order has already been processed to prevent duplicates.
- **Organization Resolution**: Safely identifies which Organization the webhook belongs to based on the shop domain.

### ✅ Verification Engine (Core Hub)

- **Central Logic**: `VerificationHubService` acts as the brain.
- **Flow Control**:
  1. Creates a `verification` record (State: `pending`).
  2. Triggers the WhatsApp message sending.
  3. Updates state to `sent` upon successful API call.
- **State Management**: Tracks verifying status (`pending`, `sent`, `confirmed`, `canceled`).

### ✅ WhatsApp Integration (Meta Spoke)

- **Sending Messages**: Sends generic verification templates (implied).
- **Webhook Handling**: `WhatsAppWebhookController` validates and processes incoming Meta signals.
  - **Status Updates**: Tracks `delivered` and `read` statuses.
  - **Interactive Buttons**: Handles `confirm` and `cancel` button clicks from the user.

### ✅ Closing the Loop

- **Shopify Sync**: Upon user verification (Confirm/Cancel):
  - The `VerificationHubService` calls back to Shopify.
  - Adds a tag to the order (e.g., `Akeed: Verified`, `Akeed: Canceled`).

---

## 2. ROI Checklist (Remaining for Robust MVP)

While the "Happy Path" works, the following items are critical for a production-ready MVP to ensure security, reliability, and data integrity.

### 🚨 Critical (Must Do)

- [ ] **Enable Security Guard**: The `ShopifyHmacGuard` is currently commented out in `ShopifyController`. This allows anyone to simulate a webhook and inject fake orders.
  - _Action_: Uncomment `@UseGuards(ShopifyHmacGuard)` and ensure the guard allows `rawBody` access for HMAC calculation.
- [ ] **Phone Number Validation**: The current phone extraction logic is "best effort".
  - _Action_: Implement a phone number library (e.g., `google-libphonenumber`) to normalize numbers to E.164 format (e.g., `+966...`) before saving/sending. This prevents WhatsApp API errors.
- [ ] **Error Handling & Retries**: The database schema has `attempts` and `nextRetryAt` columns, but there is **no active scheduler** found in the code to process these.
  - _Action_: Implement a Cron Job (via `@nestjs/schedule`) to find "stuck" verifications (e.g., stuck in `pending` for > 15 mins) and retry sending the message or mark as `failed`.

### ⚠️ Important (Should Do)

- [ ] **Webhook Validation**: Ensure the `ShopifyHmacGuard` is robust against replay attacks (check timestamp if provided) and handles raw body parsing correctly (common NestJS pitfall).
- [ ] **Graceful Degradation**: If the Shopify API fails during the "Add Tag" step, the error is logged but not retried.
  - _Action_: Add a simple retry mechanism or a "sync status" column to ensure tags are eventually applied.
- [ ] **Environment Validation**: Ensure `WA_VERIFY_TOKEN`, `SHOPIFY_API_SECRET`, etc., are enforced in `ConfigModule` validation schema.

### ℹ️ Nice to Have

- [ ] **Dashboard Visibility**: A basic endpoint to list "Recent Verifications" for the frontend dashboard.
- [ ] **Structured Logging**: Switch from `Console` logging to a structured logger (e.g., `winston` or `pino`) for better debugging in production.
