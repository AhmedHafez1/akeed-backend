# US-04-02 localized manual order entry evidence

**Validated:** 2026-09-05  
**Revision:** frontend `b8e593f` and backend `502335d` plus the recorded working-tree changes  
**Decision:** implemented locally; release remains blocked by the dependent Standalone lifecycle, dashboard, merchant-acceptance, and target-environment validation stories

## Implemented behavior

- Added an Arabic/English Standalone dashboard modal for COD-only manual orders. The embedded Shopify skin has no manual-order action or mode branch.
- Captures an international phone, optional customer name/reference, positive two-decimal amount, one of the 11 approved currencies, and a visible checked `cash_on_delivery` option.
- Defaults currency only when the configured shipping currency is supported; otherwise the merchant must select one.
- Uses the authenticated `POST /api/orders` helper with a 30-second abort timeout and a UUID created only for the first API attempt.
- Holds the token and payload in component memory only. Network, abort, timeout, and durable-acceptance ambiguity lock the submitted values and reuse the same token on safe retry.
- Provides a localized two-step start-over warning. Starting over clears the snapshot and token; successful close or “Create another order” also resets them.
- Treats matching duplicate replay as accepted, displays the order ID, and says “Accepted · Processing pending” without implying sent or delivered. The success action opens the Standalone verifications list.
- Maps stable backend codes and field names to localized copy without rendering English server validation messages. Unknown server failures remain distinct from network ambiguity and do not unnecessarily lock the form.
- Publishes `page_context.permissions.can_create_manual_order` for owners/admins only. The frontend requires an explicit `true`, so missing permission data, viewers, and disconnected sources fail closed.
- Corrected Standalone `tab=confirmations` routing to render the Standalone verifications list while preserving `/dashboard` metrics and embedded defaults.
- Extended the shared dialog and international-phone primitives with localized close text, logical alignment, stable IDs, accessible descriptions/errors, and explicit LTR phone direction without breaking existing callers.

## Browser and accessibility evidence

The isolated loopback fixture intercepted all order API traffic; no authenticated account, provider, or production data was used.

- English LTR and Arabic RTL layouts rendered with localized labels, errors, buttons, status regions, close text, and logical alignment. Phone, amount, reference, and IDs remained LTR.
- Keyboard opening, focus containment, Escape dismissal while idle, blocked dismissal while pending, native label associations, `aria-invalid`/`aria-describedby`, and first-invalid-field focus were checked. Empty and server-side phone validation both focused `manual-order-phone`.
- Required phone/amount/currency, invalid phone/amount, supported-currency selection, and 255/100-character input limits were checked against the rendered controls and validation schema.
- Owner/admin success, duplicate recovery, viewer denial, disconnected source, role/source/entitlement errors, backend field errors, idempotency conflict, durable-acceptance failure, network ambiguity, unknown HTTP 500, and the real 30-second timeout were exercised.
- A held request kept submit/cancel/close unavailable and recorded one request. Network retry recorded identical payloads and the same UUID token across both attempts.
- Ambiguous failures locked all order fields and exposed safe retry plus the two-step duplicate warning. Unexpected HTTP 500 remained editable. Successful “Create another order” cleared the order fields and token.
- Accepted/pending feedback remained visually and textually distinct from sent/delivered and exposed the returned synthetic order ID plus `/en/verifications` or `/ar/verifications` navigation.

## Automated validation results

| Check                                                             | Result                                                                                                                                   |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Manual-order controller/service and verification permission tests | PASS — 3 suites, 22 tests                                                                                                                |
| PostgreSQL manual-order ingestion contract                        | PASS — 1 suite, 5 tests                                                                                                                  |
| Full backend Jest regression                                      | PASS — 54 suites, 590 tests                                                                                                              |
| Backend build                                                     | PASS                                                                                                                                     |
| Backend non-fixing ESLint                                         | PASS — 0 errors; 19 pre-existing unsafe-argument warnings in tests                                                                       |
| Backend structured-log check                                      | PASS — 0 violations                                                                                                                      |
| E03 compatibility gate                                            | PASS, including E02 compatibility, PostgreSQL contracts, frontend checks/build, role guards, and Standalone provisioning/pilot contracts |
| Frontend application typecheck                                    | PASS                                                                                                                                     |
| Frontend isolated fixture typecheck                               | PASS                                                                                                                                     |
| Frontend non-fixing ESLint                                        | PASS — 0 warnings                                                                                                                        |
| Frontend isolated production build                                | PASS                                                                                                                                     |
| English/Arabic loopback browser smoke                             | PASS                                                                                                                                     |
| Authenticated Standalone target-environment UI/API smoke          | NOT RUN — requires deployed owner/admin/viewer identities and a ready pilot source                                                       |
| Standalone verification lifecycle and live WhatsApp send/callback | NOT RUN — owned by US-04-03 and inherited provider release gates                                                                         |

One initial production-build attempt could not fetch Inter from Google Fonts. The isolated retry and the production build inside the E03 compatibility gate both passed; no source change was required for that transient network condition.

## Rollout and recovery

Use [Standalone manual order creation](MANUAL_ORDER_CREATION.md) as the UI, API, and recovery contract. Do not expose the modal outside Standalone mode or when the permission is absent. For network, abort, timeout, or `MANUAL_ORDER_ACCEPTANCE_FAILED`, keep the modal snapshot and retry with the same token. Starting over is an explicit operator decision because the previous request may already exist.

Rollback is application-only: hide/remove the dashboard action and preserve accepted orders/events. No schema rollback or draft-storage cleanup is required because this story adds no migration and stores no customer draft in browser persistence.

## Remaining release blockers

- Implement and validate Standalone normalization and the shared verification lifecycle in US-04-03.
- Complete Standalone order/lifecycle visibility and supported actions in US-04-04.
- Complete the real merchant journey and release decision in US-04-05.
- Run authenticated target-environment owner/admin/viewer, disconnected-source, duplicate, retry, and tenant-isolation smoke tests.
- Complete authorized Meta send/callback and inherited Shopify/provider regression evidence before release.
