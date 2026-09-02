# US-02-01 Canonical Commerce Contract Evidence

**Validation date:** 2026-09-02  
**Working tree:** Local implementation; no commit or deployment claimed.

## Delivered

- One shared runtime/type platform contract includes Shopify, Salla, Zid, WooCommerce, Standalone, and EasyOrders.
- The normalized order contract carries trusted source identity, source identifiers, E.164 phone, decimal-string amount, currency, normalized payment signals, explicit COD status, and an opaque typed payload.
- Shopify normalization emits the canonical payment fields while eligibility retains legacy `paymentMethod` and raw-payload fallback behavior.
- Unknown platform values are explicitly skipped and never routed to Shopify.
- Migration `0023_expand_commerce_platform_contracts.sql` expands both integration and billing-claim checks without rewriting rows.
- No frontend selectors, native Standalone/EasyOrders adapters, integrations, or billing claims were created.

## Verification Results

- Focused Jest contract/normalizer/eligibility/queue/schema tests: **77 passed**.
- Full backend Jest suite: **35 suites, 380 tests passed**.
- `npm run build`: passed.
- `npm run log:check`: passed with 0 violations.
- Non-fixing ESLint: passed with 0 errors and 23 pre-existing unsafe-test-argument warnings outside this story's changes.
- Disposable PostgreSQL contract rehearsal: test coverage was added, but execution was blocked because Docker is not installed on this host. Direct execution also confirmed that `E01_TEST_DATABASE_URL` is not configured. Run `scripts/test-shopify-contract.ps1` on a Docker-enabled host, or provide the documented isolated local PostgreSQL database, before deployment.

## Deployment and Recovery

Deploy migration `0023` before application code writes either new platform value. Rolling the application back is safe while the expanded checks remain installed. Do not restore the previous checks after new values have been stored; first disable new writes and verify that no retained row uses the added values.
