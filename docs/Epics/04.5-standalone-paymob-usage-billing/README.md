# E04.5 — Standalone Paymob Usage-Based Billing MVP

- **Horizon:** NEXT — execute before E05
- **Status:** Done
- **Stories:** 9
- **Prerequisite epics:** [E04 — Standalone Manual Order MVP](../04-standalone-manual-order-mvp/README.md)
- **Next epic:** [E05 — Standalone Order Ingestion API](../05-standalone-order-ingestion-api/README.md)
- **Roadmap:** [Expansion backlog](../README.md)
- **Provider documentation reviewed:** 2026-09-09

## Business objective

Let verified Egyptian Standalone merchants buy non-expiring message credits through Paymob and continue verifying orders without staff-managed quota renewals, while leaving Shopify subscription plans and periods unchanged.

## Measurable outcome

- Verified signup creates one active credit account and exactly one 30-credit launch grant per Standalone organization.
- Owners/admins can buy 100–5,000 credits in increments of 50 at EGP 2.00 per credit; viewers are read-only.
- A verified successful Paymob server callback grants purchased credits exactly once.
- Every posted balance change has an immutable ledger entry, and concurrent sends cannot overspend.
- One credit is consumed for every initial or follow-up message accepted by Meta; confirmed failures restore it and ambiguous outcomes retain a hold for reconciliation.
- Zero available credits or credit debt blocks only new billable sends. Existing orders, verification history and billing history remain accessible.
- Existing Shopify checkout, subscription, plan, quota and rolling 30-day behavior passes unchanged.

## Approved product decisions

| Decision | Approved value |
| --- | --- |
| Initial market/provider | Egypt / Paymob |
| Checkout | Paymob Unified Hosted Checkout |
| Payment methods | Online cards and Vodafone Cash through the Paymob wallet integration |
| Unit price | EGP 2.00 / 200 piastres per credit |
| Purchase quantity | Minimum 100, maximum 5,000, step 50 |
| Free grant | 30 credits exactly once at verified signup |
| Expiration | Free and paid credits do not expire |
| Billing model | Prepaid, no renewal or recurring subscription |
| Billable event | Meta accepts the message and returns a provider message ID |
| Follow-up | Each accepted follow-up consumes one additional credit |
| Pre-accept failure | Confirmed failure releases the hold; ambiguous outcome remains held |
| Delivery failure | Confirmed failed delivery reverses the posted consumption once |
| Refund/chargeback | Reverse affected purchased credits; any shortfall becomes debt and blocks new sends |
| Low-balance threshold | 10 available credits |

The backend derives quantity constraints, unit price, total amount, currency, organization, actor, integration IDs and payment state. Browser values and Paymob redirects are never authority for a credit grant.

## Confirmed current-state baseline

The following findings are verified from the current code and are constraints for the stories:

- Standalone provisioning currently writes `billingStatus = not_required`, Starter plan and an activation anchor immediately. That produces 30 sends per rolling 30-day period and does not enforce a meaningful staff approval gate.
- Usage is currently reserved before the Meta call in `VerificationMessageDispatchesRepository.claim`. A provider acceptance keeps that unit; follow-ups use their own dispatch and therefore consume another unit.
- A duplicate worker reuses the dispatch identity and does not intentionally reserve twice. The latest code releases monthly usage for a provider call with no message ID and for a later failed delivery callback; staff acceptance restores an earlier release.
- Current Standalone and Shopify accounting both use `integration_monthly_usage`, plan IDs and the rolling 30-day period helper. Paymob credits must not reuse those Shopify-oriented fields.
- Reusable foundations include dispatch identities and leases, row-level locking, organization-derived dual auth, membership roles, server-side idempotency patterns, admin AAL2/feature guards, admin audit rows, structured logging, raw-body support and timing-safe signature examples.
- Historical E04 evidence that an ambiguous send remains consumed is stale against the latest code. E04.5 intentionally changes only the Standalone rule to “held until reconciliation”; Shopify keeps its characterized E04 behavior.

Important current symbols:

- [`provisionStandaloneSourceForOrganization`](../../../src/infrastructure/database/repositories/standalone-organization-provisioning.repository.ts)
- [`resolveEntitlement`](../../../src/shared/billing/entitlement.ts)
- [`BillingEntitlementService`](../../../src/modules/verification-core/billing-entitlement.service.ts)
- [`VerificationMessageDispatchesRepository`](../../../src/infrastructure/database/repositories/verification-message-dispatches.repository.ts)
- [`VerificationSendService`](../../../src/modules/verification-core/verification-send.service.ts)
- [`MessageDispatchResolutionService`](../../../src/modules/admin/message-dispatch-resolution.service.ts)
- [`AdminAccessGuard`](../../../src/modules/admin/admin-access.guard.ts)
- [`SettingsStandaloneSkin`](../../../../akeed-frontend/src/features/settings/skins/standalone/SettingsStandaloneSkin.tsx)

## Scope and boundaries

In scope: provider-neutral purchase and credit domains, audited approval/grant, transactional usage holds and postings, Paymob checkout/callback/inquiry adapter, merchant billing UI, staff reconciliation, Arabic/English localization, monitoring and controlled rollout.

Out of scope: recurring Paymob subscriptions, automatic renewal, saved cards, direct Vodafone Cash APIs, credit expiration, tiered pricing, coupons, customer-to-customer transfers, merchant self-service refunds, arbitrary partial-refund automation, invoice/tax-policy invention, and changes to Shopify plans or billing screens.

## Prioritized user stories and commit boundaries

Each story is an independent implementation patch/commit series. Do not mix work from the next story into the current story. A story commit is complete only when its acceptance tests and dated evidence are included; follow-up fixes for that story remain in the same story series.

| Rank | Story | Priority | Type | Direct dependencies | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | [US-04.5-01 — Establish the credit and payment domain](US-04.5-01-credit-and-payment-domain-foundation.md) | P0 | Technical enabler | [US-04-05](../04-standalone-manual-order-mvp/US-04-05-manual-mvp-merchant-acceptance.md) | Done |
| 2 | [US-04.5-02 — Approve merchants and grant launch credits](US-04.5-02-approval-and-one-time-grant.md) | P0 | Feature | [US-04.5-01](US-04.5-01-credit-and-payment-domain-foundation.md) | Done |
| 3 | [US-04.5-03 — Account for Standalone message usage](US-04.5-03-provider-neutral-usage-accounting.md) | P0 | Technical enabler | [US-04.5-02](US-04.5-02-approval-and-one-time-grant.md) | Done |
| 4 | [US-04.5-04 — Buy credits through Paymob safely](US-04.5-04-paymob-checkout-and-callbacks.md) | P0 | Feature | [US-04.5-03](US-04.5-03-provider-neutral-usage-accounting.md) | Done |
| 5 | [US-04.5-05 — Use the merchant billing experience](US-04.5-05-merchant-billing-experience.md) | P0 | Feature | [US-04.5-04](US-04.5-04-paymob-checkout-and-callbacks.md) | Done |
| 6 | [US-04.5-06 — Operate and reconcile Standalone billing](US-04.5-06-staff-billing-operations.md) | P0 | Operations | [US-04.5-05](US-04.5-05-merchant-billing-experience.md) | Done |
| 7 | [US-04.5-07 — Monitor billing and revenue integrity](US-04.5-07-observability-and-finance-reconciliation.md) | P1 | Operations | [US-04.5-06](US-04.5-06-staff-billing-operations.md) | Done |
| 8 | [US-04.5-08 — Prove sandbox and controlled-production readiness](US-04.5-08-sandbox-and-production-release-gate.md) | P0 | Quality gate | [US-04.5-07](US-04.5-07-observability-and-finance-reconciliation.md) | Done |
| 9 | [US-04.5-09 — Activate Standalone accounts at verified signup](US-04.5-09-standalone-signup-auto-activation.md) | P0 | Feature | [US-04.5-02](US-04.5-02-approval-and-one-time-grant.md) | Done |

US-04.5-09 supersedes the staff approval step from US-04.5-02: accounts are activated with their launch grant at verified signup.

## Merchant and staff workflow

1. The merchant signs up and verifies their email address.
2. Provisioning creates the organization, the Standalone source and an active credit account with no Standalone plan entitlement.
3. The same transaction posts `free_grant +30` under `standalone-free-grant:<orgId>:v1`, with the owner as actor.
4. Every member can read balance, holds, debt, ledger and purchase history. Only owner/admin can start checkout; viewers see a localized read-only state.
5. The backend validates quantity and creates a pending local purchase before calling Paymob Create Intention with trusted EGP amount and internal reference.
6. The merchant chooses card or Vodafone Cash inside Paymob Unified Checkout. Akeed never receives or stores card/wallet credentials.
7. Return-page query values provide UX context only. The page reads and briefly polls Akeed’s canonical purchase endpoint.
8. A verified, matching Paymob processed callback atomically marks success, posts `purchase +quantity`, and updates the balance projection once.
9. Sending atomically holds one available credit before the Meta call. Meta acceptance posts `consumption -1`; confirmed pre-accept failure releases; failed delivery posts `failure_reversal +1`; ambiguity remains held until audited staff resolution.
10. Staff can inspect and reconcile purchases/events/holds/ledger, apply signed adjustments, and record refunds or disputes without manually asserting an unverified payment success.

## Canonical state machines

### Payment purchase

`pending` may become `successful`, `failed`, `canceled` or inquiry-confirmed `expired`. A delayed verified success may promote `failed`, `canceled` or `expired` to `successful`. A full verified refund promotes `successful` to `refunded`. Failure/pending events never downgrade `successful` or `refunded`; refund dominates success. Disputes are separately `none | open | lost | won`.

Partial refunds remain `successful`, record the refunded minor amount, and enter reconciliation unless the refund maps exactly to whole credits under the original immutable unit price. Browser redirects never cause a transition.

### Credit accounting

`available = max(posted_balance - held_credits, 0)`, with negative posted balance exposed as debt. Every posted balance mutation and its projection update occur in the same locked transaction.

| Event | Reservation | Immutable ledger | Projection |
| --- | --- | --- | --- |
| Approval | None | `free_grant +30` | posted +30 |
| Verified payment | None | `purchase +quantity` | posted +quantity |
| Before Meta call | `held` | None | held +1 |
| Meta acceptance | `consumed` | `consumption -1` | posted -1, held -1 |
| Confirmed pre-accept failure | `released` | None | held -1 |
| Confirmed delivery failure | `released` | `failure_reversal +1` | posted +1 |
| Ambiguous accepted resolution | `consumed` | `consumption -1` | posted -1, held -1 |
| Ambiguous rejected resolution | `released` | None | held -1 |
| Staff adjustment | None | signed `staff_adjustment` | posted ±quantity |
| Refund/dispute loss | None | negative reversal | posted -affected credits |
| Dispute won | None | `chargeback_reinstatement` | posted +affected credits |

One remaining available credit permits exactly one concurrent hold. Refunds do not cancel valid in-flight holds, but debt or zero availability prevents every new hold.

## Contract summary

Merchant APIs are authenticated, organization-derived and `Cache-Control: private, no-store`:

- `GET /api/billing/credits`
- `GET /api/billing/credits/ledger?cursor=&limit=&type=`
- `GET /api/billing/purchases?cursor=&limit=`
- `GET /api/billing/purchases/:purchaseRef`
- `POST /api/billing/purchases` with `{ quantity }` and required `Idempotency-Key`; owner/admin only

Provider callback:

- `POST /api/webhooks/payments/paymob`; public only to Paymob, HMAC verified and replay safe

Staff APIs live under `/api/admin/standalone-billing` and reuse existing feature flag, throttling, AAL2 guard and audit conventions.

Standalone send denials use `STANDALONE_APPROVAL_REQUIRED`, `INSUFFICIENT_CREDITS`, `CREDIT_ACCOUNT_SUSPENDED`, `CREDIT_DEBT_OUTSTANDING` or `PAYMENT_PENDING_RECONCILIATION`. Shopify keeps its current error contracts.

Server-only configuration is validated at startup when `STANDALONE_CREDIT_BILLING_ENABLED=true`:

`STANDALONE_CREDIT_PRICE_MINOR=200`, `STANDALONE_FREE_GRANT=30`, `STANDALONE_PURCHASE_MIN=100`, `STANDALONE_PURCHASE_MAX=5000`, `STANDALONE_PURCHASE_STEP=50`, `STANDALONE_LOW_BALANCE_THRESHOLD=10`, `PAYMOB_MODE`, `PAYMOB_BASE_URL`, `PAYMOB_SECRET_KEY`, `PAYMOB_PUBLIC_KEY`, `PAYMOB_HMAC_SECRET`, `PAYMOB_CARD_INTEGRATION_ID`, `PAYMOB_WALLET_INTEGRATION_ID`, `PAYMOB_CALLBACK_URL`, `PAYMOB_RETURN_URL`, and `PAYMOB_CHECKOUT_EXPIRATION_SECONDS`.

## Provider and security rules

- `PaymentsPort` owns provider-neutral checkout/inquiry contracts; `PaymobPaymentsAdapter` alone knows Paymob payloads, credentials, URLs and status mapping. Verification/orders/messaging modules never import Paymob.
- Create Intention is a backend call authenticated with `Token <secret key>`. Amount is an integer minor amount; `special_reference` is Akeed’s unique internal reference; configured card/wallet integration IDs define payment methods.
- Paymob documents `notification_url` as supported only for card integration IDs. Configure processed callbacks in both card and wallet integrations and use the per-intention URL where supported; validate the wallet callback in sandbox before release.
- Build Unified Checkout only from configured public key and Paymob’s returned intention `client_secret`. Never log the client secret or expose server keys.
- Validate the processed callback SHA-512 HMAC over Paymob’s documented ordered fields and compare equal-length byte buffers with a timing-safe comparison. Then match reference, provider IDs, amount, currency, integration/profile ownership and test/live mode to the stored purchase.
- Persist a sanitized event hash/fingerprint, not raw payment credentials or full callback PII. Never store PAN, CVV, wallet credentials or reusable payment tokens.
- Callback state transition, provider event, ledger grant and account projection commit together. Return non-2xx on database failure so a retry can complete safely; a lost 2xx response replays as a no-op.

## Failure and recovery invariants

- Definite Create Intention 4xx → local `failed` with a safe code. Timeout/5xx/lost response → remain pending with reconciliation required; inquiry the same reference and never create a second intention for the same idempotency key.
- Duplicate/replayed callback → same event/ledger keys, no duplicate grant. Delayed/out-of-order callbacks apply precedence rather than arrival order.
- Stale pending/expiry → inquire first; mark expired only when Paymob confirms no success.
- Successful callback with mismatched trusted data → quarantine for reconciliation, grant nothing.
- Ledger/projection mismatch → stop mutations for the account, alert, rebuild projection from the immutable ledger under lock and audit the repair.
- Exact full/whole-credit refund can reverse automatically. Non-exact partial refunds remain quarantined for staff resolution. Chargeback open/lost reverses immediately; won reinstates once.
- Disable rollback stops new checkout/holds and preserves accounts, purchases, callbacks, ledger, orders and verification history.

## Metrics and release gate

Track grants, free utilization, time to first accepted send, low/zero balance, checkout starts and terminal states, paid conversion, first/repeat purchase, credits and EGP collected, refunds/chargebacks/fees/net revenue, average purchase, ARPPU, unspent paid-credit liability, initial/follow-up consumption and failure reversals.

Release remains blocked until the additive migration and concurrency contracts, all story tests, E04 and Shopify regressions, Paymob card and Vodafone Cash sandbox journeys, controlled live purchase/callback/send/refund/debt flow, inquiry/reconciliation, settlement evidence, both locales/roles and production monitoring pass with no duplicate grants, cross-tenant access or ledger mismatch.

## Official provider references

These are implementation inputs, not evidence that the Akeed Paymob account or payment methods are enabled:

- [Paymob — API integration flow and Unified Checkout](https://developers.paymob.com/paymob-docs/integration-paths/apis)
- [Paymob — Create Intention](https://developers.paymob.com/paymob-docs/developers/intention-apis/create-intention)
- [Paymob — Transaction callbacks](https://developers.paymob.com/paymob-docs/developers/webhook-callbacks-and-hmac/transaction-callbacks)
- [Paymob — Transaction callback HMAC](https://developers.paymob.com/paymob-docs/developers/webhook-callbacks-and-hmac/hmac/hmac-transaction-callback)
- [Paymob — Inquiry by order ID or reference](https://developers.paymob.com/paymob-docs/developers/transaction-inquiry-apis/transaction-inquiry/by-order-id-or-reference)
- [Paymob — Transaction inquiry and reports](https://developers.paymob.com/paymob-docs/payments-and-features/core-features/transaction-inquiry-and-reports)

Before release Paymob must enable/confirm the Egyptian merchant account, test/live public and secret keys, HMAC secret, separate online-card and mobile-wallet integration IDs, Vodafone Cash on the wallet integration, Unified Checkout, processed/response callback URLs for both integrations, transaction inquiry, refund access and the settlement/dispute reporting process. Finance must record contracted fees, VAT, settlement timing, refund fees and chargeback terms.
