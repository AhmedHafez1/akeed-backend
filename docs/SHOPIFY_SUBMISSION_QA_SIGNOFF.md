# Shopify Submission QA Sign-Off Sheet

Last Updated: 2026-03-27
Owner: **\*\*\*\***\_\_\_\_**\*\*\*\***
Build/Commit: **\*\*\*\***\_\_\_\_**\*\*\*\***
Environment: **\*\*\*\***\_\_\_\_**\*\*\*\***

## Rules (Strict PASS/FAIL)

- For every test case, check exactly one column: PASS or FAIL.
- Do not leave critical tests unresolved.
- Any FAIL in P0 blocks submission.
- Store proof links in the Evidence column (screenshots, logs, webhook IDs, videos).

## Sign-Off Gate

- P0 Total: **\_\_**
- P0 Passed: **\_\_**
- P0 Failed: **\_\_**
- Final Decision: [ ] PASS (Ready to submit) [ ] FAIL (Not ready)

---

## A) Install, Auth, and Embedded Runtime

| ID   | Priority | Test Case                            | Expected Result                                                 | Evidence | PASS | FAIL | Notes |
| ---- | -------- | ------------------------------------ | --------------------------------------------------------------- | -------- | ---- | ---- | ----- |
| A-01 | P0       | Fresh install from Partner Dashboard | App installs and opens in embedded context without loop         |          | [P]  | [ ]  |       |
| A-02 | P0       | OAuth callback integrity             | Callback succeeds with valid params and returns merchant to app |          | [P]  | [ ]  |       |
| A-03 | P0       | App Bridge token exchange path       | Embedded token exchange succeeds and protected API access works |          | [P]  | [ ]  |       |
| A-05 | P1       | Reinstall after uninstall            | Reinstall completes and app remains operational                 |          | [P]  | [ ]  |       |

## B) Onboarding and Billing

| ID   | Priority | Test Case                            | Expected Result                                                        | Evidence | PASS | FAIL | Notes |
| ---- | -------- | ------------------------------------ | ---------------------------------------------------------------------- | -------- | ---- | ---- | ----- |
| B-01 | P0       | Onboarding progression               | Welcome -> configuration -> billing works with validation              |          | [P]  | [ ]  |       |
| B-02 | P0       | Starter plan first-time claim        | Starter activates and onboarding completes                             |          | [P]  | [ ]  |       |
| B-03 | P0       | Starter plan second claim attempt    | Starter cannot be reclaimed for same store and user gets clear error   |          | [P]  | [ ]  |       |
| B-04 | P0       | Paid plan approval                   | Shopify approval returns to callback and billing status becomes active |          | [P]  | [ ]  |       |
| B-05 | P0       | Paid plan decline                    | Decline path returns safely and app reflects non-active billing        |          | [P]  | [ ]  |       |
| B-06 | P0       | Plan change flow                     | Existing subscription is handled and new plan is applied correctly     |          | [P]  | [ ]  |       |
| B-09 | P0       | Blocked billing statuses enforcement | canceled/declined/expired/frozen statuses block order processing       |          | [P]  | [ ]  |       |

## C) Shopify Webhooks and Queue Processing

| ID   | Priority | Test Case                            | Expected Result                                                   | Evidence | PASS | FAIL | Notes |
| ---- | -------- | ------------------------------------ | ----------------------------------------------------------------- | -------- | ---- | ---- | ----- |
| C-01 | P0       | orders/create webhook (valid HMAC)   | Event accepted and enqueued for processing                        |          | [P]  | [ ]  |       |
| C-02 | P0       | orders/create webhook (invalid HMAC) | Request is rejected and no processing occurs                      |          | [P]  | [ ]  |       |
| C-03 | P0       | app/uninstalled webhook              | Integration and related state are deactivated/removed as designed |          | [P]  | [ ]  |       |
| C-04 | P0       | app_subscriptions_update webhook     | Billing status updates are persisted correctly                    |          | [P]  | [ ]  |       |
| C-05 | P0       | Webhook idempotency                  | Duplicate webhook ID does not create duplicate side effects       |          | [P]  | [ ]  |       |

## D) Verification and WhatsApp Flow

| ID   | Priority | Test Case                         | Expected Result                                                                      | Evidence | PASS | FAIL | Notes |
| ---- | -------- | --------------------------------- | ------------------------------------------------------------------------------------ | -------- | ---- | ---- | ----- |
| D-01 | P0       | COD eligibility filter            | Non-COD orders are skipped with expected reason                                      |          | [P]  | [ ]  |       |
| D-02 | P0       | Verification creation idempotency | Same order does not produce duplicate verification records                           |          | [P]  | [ ]  |       |
| D-03 | P0       | Outbound WhatsApp template send   | Verification transitions pending -> sent with wa message id                          |          | [P]  | [ ]  |       |
| D-04 | P0       | Delivery/read status callback     | Verification status updates to delivered/read from webhook events                    |          | [P]  | [ ]  |       |
| D-05 | P0       | Confirm quick reply               | Verification finalizes confirmed and Shopify order gets tag Akeed: Verified          |          | [P]  | [ ]  |       |
| D-06 | P0       | Cancel quick reply                | Verification finalizes canceled and Shopify order gets tag Akeed: Canceled           |          | [P]  | [ ]  |       |
| D-07 | P0       | Plan limit exceeded path          | Verification is marked failed with plan_limit_reached and no outbound send           |          | [P]  | [ ]  |       |
| D-08 | P1       | Overage usage record path         | Overage charge is reported successfully (or reservation rollback works on rejection) |          | [ ]  | [ ]  |       |

## E) Privacy, Security, and Multi-Tenant Safety

| ID   | Priority | Test Case                           | Expected Result                                                            | Evidence | PASS | FAIL | Notes |
| ---- | -------- | ----------------------------------- | -------------------------------------------------------------------------- | -------- | ---- | ---- | ----- |
| E-01 | P0       | GDPR customers/data_request webhook | Data export payload generation succeeds for requested customer/order scope |          | [P]  | [ ]  |       |
| E-02 | P0       | GDPR customers/redact webhook       | Customer PII is redacted in persisted records                              |          | [P]  | [ ]  |       |
| E-03 | P0       | GDPR shop/redact webhook            | Org-level data is deleted according to policy                              |          | [P]  | [ ]  |       |
| E-04 | P0       | Tenant isolation check              | Shop A cannot read or mutate Shop B resources                              |          | [P]  | [ ]  |       |

## F) Frontend UX and Localization

| ID   | Priority | Test Case                          | Expected Result                                                             | Evidence | PASS | FAIL | Notes |
| ---- | -------- | ---------------------------------- | --------------------------------------------------------------------------- | -------- | ---- | ---- | ----- |
| F-01 | P0       | Embedded dashboard rendering       | Embedded skin loads with data and no auth gate dead-end                     |          | [P]  | [ ]  |       |
| F-03 | P1       | Embedded onboarding guard behavior | Landing/dashboard routes redirect correctly by onboarding status            |          | [P]  | [ ]  |       |
| F-04 | P1       | Settings update flow               | Settings save and readback are consistent (store, language, shipping prefs) |          | [P]  | [ ]  |       |
| F-05 | P1       | Arabic/English localization        | Locale switching and RTL/LTR rendering work correctly                       |          | [P]  | [ ]  |       |

## G) Operational Readiness

| ID   | Priority | Test Case                               | Expected Result                                                      | Evidence | PASS | FAIL | Notes |
| ---- | -------- | --------------------------------------- | -------------------------------------------------------------------- | -------- | ---- | ---- | ----- |
| G-01 | P0       | Backend production build                | Build succeeds without runtime-breaking errors                       |          | [P]  | [ ]  |       |
| G-02 | P0       | Frontend production build               | Build succeeds and app boots correctly                               |          | [P]  | [ ]  |       |
| G-03 | P1       | Key env validation                      | Required Shopify, billing, Redis, and WhatsApp env vars are verified |          | [P]  | [ ]  |       |
| G-04 | P1       | App uninstall/reinstall lifecycle smoke | Lifecycle passes without orphaned broken state                       |          | [P]  | [ ]  |       |

---

## Final Approvals

Submission is allowed only when Final Decision is PASS and all P0 tests are PASS.
