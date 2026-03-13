# Akeed Backend — Architecture Review

**Date:** 2026-03-12
**Reviewer:** Senior Backend Engineer & NestJS Architect
**Scope:** Full codebase structural and architectural review
**Team Size Assumption:** 8+ developers

---

## 1. Architecture Summary

### High-Level Architecture

Akeed is a **multi-tenant COD (Cash On Delivery) order verification SaaS** built on NestJS. It integrates with Shopify via embedded app mode and communicates with customers through WhatsApp (Meta Cloud API). The platform verifies COD orders by sending WhatsApp messages to customers and tagging orders back in Shopify based on replies.

### Architectural Pattern

The codebase follows a **modular monolith** with partial hexagonal (ports & adapters) patterns:

| Layer              | Location              | Purpose                                                       |
| ------------------ | --------------------- | ------------------------------------------------------------- |
| **Core Domain**    | `src/core/`           | Business logic, services, ports, DTOs, controllers            |
| **Infrastructure** | `src/infrastructure/` | Database (Drizzle ORM), external integrations (Shopify, Meta) |
| **Shared**         | `src/shared/`         | Cross-cutting concerns: guards, filters, utils                |

### Key Patterns Identified

- **Ports & Adapters** for `MessagingPort` and `OrderTaggingPort` — correctly abstracts WhatsApp and Shopify tagging behind interfaces
- **Strategy Pattern** for order eligibility (`OrderEligibilityStrategy` per platform)
- **Dynamic Module** (`VerificationCoreModule.register()`) for wiring ports at composition root
- **BullMQ Queue** for async webhook processing with proper idempotency
- **Repository Pattern** for data access via Drizzle ORM

### Domain Flow

```
Shopify Webhook → HMAC Guard → Webhook Controller → BullMQ Queue
  → Processor → Normalizer → VerificationHub → WhatsApp (via MessagingPort)
    → Customer Reply → WhatsApp Webhook → Update Verification → Tag Order (via OrderTaggingPort)
```

---

## 2. Major Structural Issues

### 2.5 — MEDIUM: `WhatsAppWebhookService` Lives in Infrastructure but Calls Core Domain Directly

**File:** `src/infrastructure/spokes/meta/whatsapp.webhook.service.ts`

```typescript
import { VerificationHubService } from 'src/core/services/verification-hub.service';
```

Infrastructure → Core dependency is correct directionally, but combining raw webhook parsing with domain logic in one method creates testing difficulty and violates separation of concerns. The button payload parsing (`confirm_`, `cancel_`) is tightly coupled to the domain's verification ID format.

### 2.6 — MEDIUM: `OnboardingBillingCallbackController` Uses Raw `@Req()/@Res()` — Breaks NestJS Paradigm

**File:** `src/core/controllers/onboarding-billing-callback.controller.ts`

```typescript
@Get('callback')
async billingCallback(@Req() req: Request, @Res() res: Response): Promise<void> {
    const redirectUrl = await this.onboardingService.handleBillingCallback(
        req.query as Record<string, string | undefined>,
    );
    res.redirect(redirectUrl);
}
```

Using `@Res()` bypasses NestJS interceptors, exception filters, and response serialization. The raw `req.query` casting is also unsafe — should use a DTO with `@Query()`.

### 2.7 — MEDIUM: No Pagination on List Endpoints

**Files:** `orders.controller.ts`, `verifications.controller.ts`

Both `GET /api/orders` and `GET /api/verifications` return all records for an organization without pagination. As order volume grows, these endpoints will become performance bottlenecks.

### 2.8 — MEDIUM: `WhatsAppWebhookController.verifyWebhook()` Accesses `process.env` Directly

**File:** `src/infrastructure/spokes/meta/whatsapp.webhook.controller.ts`

```typescript
if (mode === 'subscribe' && token === process.env.WA_VERIFY_TOKEN) {
```

This bypasses NestJS's `ConfigService`, making the controller harder to test and inconsistent with the rest of the codebase which uses `ConfigService`.

### 2.9 — LOW: Inconsistent Use of `@Request()` vs `@CurrentUser()` Decorators

Controllers mix two patterns for accessing the authenticated user:

- `@CurrentUser() user: AuthenticatedUser` (clean, typed)
- `@Request() req: RequestWithUser` then `req.user` (verbose, couples to Request)

Some controllers even use both patterns in the same file (`verifications.controller.ts`).

---

## 3. Scalability Risks

### 3.1 — No Pagination / Cursor-Based Fetching

`OrdersRepository.findByOrg()` and `VerificationsRepository.findByOrg()` load **all records** for an org. A merchant with 10,000+ orders will trigger heavy queries and large response payloads.

**Risk Level:** HIGH — will manifest within months of production usage.

### 3.2 — Single BullMQ Queue for All Webhook Types

All webhook events share one queue (`WEBHOOK_QUEUE_NAME`). As volume grows or new platforms are added, there's no way to independently scale or prioritize different webhook types.

**Recommendation:** Consider separate queues per platform or per webhook type for independent scaling and monitoring.

### 3.3 — In-Memory Rate Limiting

**File:** `src/shared/guards/billing-callback-rate-limit.guard.ts`

The rate limiter uses an in-memory `Map`. In a multi-instance deployment (e.g., Kubernetes), rate limits won't be shared across instances.

**Risk Level:** MEDIUM — bypassed in horizontal scaling scenarios.

### 3.4 — No Database Connection Pooling Configuration

**File:** `src/infrastructure/database/database.provider.ts`

The Drizzle provider creates a `postgres` client with default settings. No pool size, idle timeout, or connection limits are configured.

```typescript
const client = postgres(databaseUrl);
```

**Risk Level:** MEDIUM — under load, connections may exhaust the database.

### 3.5 — `DatabaseModule` Imported by Nearly Every Module

`DatabaseModule` is imported by: `AuthModule`, `OnboardingModule`, `OrdersModule`, `OrganizationsModule`, `VerificationsModule`, `WebhookQueueModule`, `VerificationCoreModule`, `ShopifyModule`, `MetaModule`.

While NestJS uses singleton scoping by default, this pattern creates implicit coupling. Any change to `DatabaseModule` exports affects all consumers.

**Recommendation:** Consider making `DatabaseModule` global (registered once in `AppModule`) and removing redundant imports.

### 3.6 — No Health Check Endpoint Beyond Root

The only health check is `GET /` returning "Hello World!". There is no readiness/liveness probe checking database connectivity, Redis, or WhatsApp API availability.

---

## 4. Recommended Module Structure

### Current Structure (Flat Core)

```
src/
  core/
    controllers/     ← All controllers in one folder
    dto/             ← All DTOs in one folder
    services/        ← All services in one folder (~12 files)
    modules/         ← Module definitions reference across folders
    guards/
    ports/
    interfaces/
    errors/
    middleware/
```

### Proposed Structure (Domain-Aligned)

```
src/
  modules/
    auth/
      auth.controller.ts
      auth.service.ts
      auth.module.ts
      dto/
      guards/
        dual-auth.guard.ts
        current-user.decorator.ts
    onboarding/
      onboarding.controller.ts
      onboarding-billing-callback.controller.ts
      onboarding.service.ts
      billing.service.ts              ← Extracted from OnboardingService
      onboarding.module.ts
      dto/
    orders/
      orders.controller.ts
      orders.service.ts
      orders.module.ts
      dto/
    organizations/
      organizations.controller.ts
      organizations.service.ts
      organizations.module.ts
      dto/
    verifications/
      verifications.controller.ts
      verifications.service.ts
      verifications.module.ts
      dto/
    verification-core/
      verification-hub.service.ts
      billing-entitlement.service.ts
      order-eligibility.service.ts
      strategies/
      verification-core.module.ts
    webhook-queue/
      webhook-queue.producer.ts
      webhook-queue.processor.ts
      normalizers/
      webhook-queue.module.ts
  infrastructure/
    database/                         ← Unchanged
    spokes/
      shopify/                        ← Unchanged
      meta/                           ← Unchanged
  shared/
    ports/                            ← Moved from core
    interfaces/                       ← Moved from core
    filters/
    guards/
    utils/
```

**Benefits:**

- Each module is self-contained with its own controllers, services, DTOs
- Developers can own modules without stepping on each other
- Clear import boundaries enforce encapsulation
- New platforms (Salla, WooCommerce) add new spokes without touching core modules

---

## 5. Refactoring Suggestions

### Priority 1 — High Impact, Low Risk

| #   | Suggestion                                                                                               | Effort  | Impact                                           |
| --- | -------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------ |
| 1   | **Split `OnboardingService`** into `OnboardingStateService`, `BillingService`, `BillingConfigService`    | Medium  | Reduces complexity, enables parallel development |
| 2   | **Add pagination** to `GET /api/orders` and `GET /api/verifications` (cursor-based)                      | Low     | Prevents performance degradation at scale        |
| 3   | **Replace `@Res()` in billing callback** controller with `@Redirect()` or return a redirect response DTO | Low     | Restores NestJS interceptor/filter chain         |
| 4   | **Use `ConfigService` in `WhatsAppWebhookController`** instead of `process.env`                          | Trivial | Consistency, testability                         |
| 5   | **Standardize on `@CurrentUser()` decorator** across all controllers; remove `@Request()` pattern        | Low     | Code consistency for 8+ developers               |

### Priority 2 — Medium Impact, Medium Risk

| #   | Suggestion                                                                     | Effort | Impact                                          |
| --- | ------------------------------------------------------------------------------ | ------ | ----------------------------------------------- |
| 6   | **Abstract `ShopifyApiService` behind a `BillingPort`** in `OnboardingService` | Medium | Enables multi-platform billing                  |
| 7   | **Extract `sendTestVerification()` out of `VerificationsService`**             | Low    | Decouples read service from write orchestration |
| 8   | **Make `DatabaseModule` global** and remove redundant imports                  | Low    | Reduces boilerplate, simplifies module graph    |
| 9   | **Add structured health check endpoint** (`/health`) with DB and Redis checks  | Low    | Production readiness                            |
| 10  | **Configure connection pooling** in database provider                          | Low    | Prevents connection exhaustion under load       |

### Priority 3 — Strategic Investments

| #   | Suggestion                                                                                         | Effort | Impact                                         |
| --- | -------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------- |
| 11  | **Restructure into domain-aligned module folders** (see Section 4)                                 | High   | Long-term maintainability at team scale        |
| 12  | **Introduce separate queues** per webhook type/platform                                            | Medium | Independent scaling and monitoring             |
| 13  | **Move rate limiting to Redis** (replace in-memory Map)                                            | Medium | Correct behavior in multi-instance deployments |
| 14  | **Add integration/e2e test coverage** for webhook processing pipeline                              | High   | Safety net for core business flow              |
| 15  | **Introduce a Billing abstraction port** (like `MessagingPort`) for multi-platform billing support | Medium | Future-proofing for Salla/WooCommerce          |

---

## 6. Detailed Findings by Category

### 6.1 Module Architecture

| Criterion                  | Assessment                                                                       |
| -------------------------- | -------------------------------------------------------------------------------- |
| Domain separation          | **Good** — Clear split between core, infrastructure, and shared                  |
| Module isolation           | **Partial** — Modules are defined but controllers/services are in shared folders |
| Infrastructure abstraction | **Good** — Ports pattern for messaging and order tagging                         |
| Circular dependencies      | **None detected** — Clean dependency graph                                       |
| Module size                | **OnboardingModule is too large** — service handles 5+ concerns                  |

### 6.2 Controller Design

| Criterion                     | Assessment                                                              |
| ----------------------------- | ----------------------------------------------------------------------- |
| HTTP-only logic               | **Good** — Controllers delegate to services consistently                |
| Business logic in controllers | **Clean** — No business logic detected in controllers                   |
| Request validation            | **Good** — `ValidationPipe` with `whitelist: true` applied consistently |
| Inconsistency                 | **Minor** — Mixed `@Request()` vs `@CurrentUser()` usage                |
| Anti-pattern                  | `@Res()` usage in billing callback bypasses NestJS pipeline             |
| Missing                       | No pagination support on list endpoints                                 |

### 6.3 Service Layer

| Criterion                | Assessment                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Business logic placement | **Good** — All business logic resides in services                                                                  |
| Service responsibilities | **Issue** — `OnboardingService` violates SRP significantly                                                         |
| Duplicated logic         | **Minor** — `getCurrentMonthStartDate()` duplicated between `BillingEntitlementService` and `VerificationsService` |
| Helper extraction        | **Good** — `onboarding.service.helpers.ts` extracts pure functions                                                 |
| Dependency injection     | **Good** — Proper constructor injection throughout                                                                 |

### 6.4 Data Layer

| Criterion                    | Assessment                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| Repository separation        | **Excellent** — One repository per aggregate, clean separation                          |
| No DB queries in controllers | **Clean** — All data access through repositories                                        |
| Reusable access patterns     | **Good** — Common query patterns encapsulated in repositories                           |
| Transaction support          | **Good** — `integration-monthly-usage.repository.ts` uses transactions with row locking |
| Token encryption             | **Good** — AES-256-GCM encryption for access tokens in repositories                     |
| Missing concerns             | No pagination in `findByOrg()` queries; no soft-delete pattern                          |

### 6.5 Dependency Injection

| Criterion             | Assessment                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------- |
| NestJS DI usage       | **Good** — Standard constructor injection, `@Inject()` for tokens                         |
| Port binding          | **Excellent** — `VerificationCoreModule.register()` with dynamic port wiring              |
| Tight coupling        | **Issue** — `OnboardingService` ↔ `ShopifyApiService` direct dependency                   |
| Global modules        | **Appropriate** — `ConfigModule` global, `VerificationCoreModule` global                  |
| Token-based injection | **Good** — `DRIZZLE`, `MESSAGING_PORT`, `ORDER_TAGGING_PORT`, `WEBHOOK_ORDER_NORMALIZERS` |

### 6.6 Error Handling

| Criterion                  | Assessment                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| Exception filters          | **Good** — `GlobalExceptionFilter` extends `BaseExceptionFilter`                                      |
| Custom exceptions          | **Partial** — Only `InvalidPhoneNumberError`; other domain errors use NestJS HTTP exceptions directly |
| Consistent error responses | **Good** — Standard NestJS exception format                                                           |
| Webhook resilience         | **Good** — WhatsApp webhook always returns 200 to prevent Meta from disabling                         |
| BullMQ error handling      | **Good** — Retry with exponential backoff, failed handler persists errors                             |
| Missing                    | No structured error codes for API consumers; no error logging correlation IDs                         |

---

## 7. Security Observations

| Area                      | Status                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------- |
| HMAC validation (Shopify) | **Secure** — Timing-safe comparison in `ShopifyHmacGuard`                          |
| Token encryption          | **Secure** — AES-256-GCM with IV and auth tag                                      |
| JWT validation            | **Secure** — Proper signature verification for Shopify session tokens              |
| Supabase auth             | **Secure** — Service role key validation via Supabase SDK                          |
| GDPR compliance           | **Implemented** — Customer data request/redact/shop redact handlers                |
| CSP headers               | **Configured** — SecurityMiddleware sets frame-ancestors for Shopify               |
| Input validation          | **Good** — `ValidationPipe` with `whitelist: true` on most controllers             |
| Raw query param trust     | **Mitigated** — Billing callback verifies charge via Shopify API, not query params |

---

## 8. Code Quality Score

| Area                 | Score (1–10) | Weight | Weighted |
| -------------------- | ------------ | ------ | -------- |
| Module Architecture  | 7            | 20%    | 1.40     |
| Controller Design    | 8            | 15%    | 1.20     |
| Service Layer        | 6            | 20%    | 1.20     |
| Data Layer           | 8            | 15%    | 1.20     |
| Dependency Injection | 7            | 10%    | 0.70     |
| Error Handling       | 6            | 10%    | 0.60     |
| Security             | 9            | 10%    | 0.90     |

### **Overall Score: 7.2 / 10**

### Score Justification

**Strengths:**

- Clean ports & adapters pattern for external integrations
- Solid repository layer with proper separation
- Production-grade security (HMAC, encryption, timing-safe)
- Good use of BullMQ for async processing with idempotency
- Controllers are properly thin — no business logic leakage
- Well-structured webhook pipeline with normalizers

**Weaknesses:**

- `OnboardingService` is a god service that will hinder parallel development
- Core domain directly imports infrastructure (Shopify utils, ShopifyApiService)
- No pagination on critical list endpoints
- Mixed decorator patterns across controllers
- Minimal custom domain exceptions (only `InvalidPhoneNumberError`)
- No health checks, no correlation IDs, no structured error codes

### Path to 9/10

1. Split `OnboardingService` into focused services
2. Abstract all platform-specific calls behind ports
3. Add pagination + cursor-based fetching
4. Restructure into domain-aligned module folders
5. Add structured health checks and request correlation
6. Standardize controller patterns (decorator usage, response handling)
7. Introduce domain-specific exceptions with error codes
