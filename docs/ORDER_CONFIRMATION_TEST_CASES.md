# Order Confirmation Workflow — Test Cases

Derived from [ORDER_CONFIRMATION_WORKFLOW.md](ORDER_CONFIRMATION_WORKFLOW.md).

---

## 5. Initial Send — Immediate

| #   | Case               | Precondition                     | Expected                                                                        |
| --- | ------------------ | -------------------------------- | ------------------------------------------------------------------------------- |
| 5.3 | Plan limit reached | Included confirmations exhausted | Status → `failed`, metadata `{ reason: 'plan_limit_reached', kind: 'initial' }` |

## 8. Customer Reply Handling

| #   | Case                                            | Button payload | Current status                      | Expected             |
| --- | ----------------------------------------------- | -------------- | ----------------------------------- | -------------------- |
| 8.3 | Confirm after no-reply (before merchant cancel) | `confirm_<id>` | `no_reply`, no `merchantCanceledAt` | Status → `confirmed` |

## 9. Status Webhooks (Meta)

| #   | Case                           | Meta status                 | Current verification status | Expected                 |
| --- | ------------------------------ | --------------------------- | --------------------------- | ------------------------ |
| 9.1 | Delivered                      | `delivered`                 | `sent`                      | Status → `delivered`     |
| 9.2 | Read                           | `read`                      | `delivered`                 | Status → `read`          |
| 9.3 | Failed                         | `failed`                    | `sent`                      | Status updated           |
| 9.4 | Late delivered after confirmed | `delivered`                 | `confirmed`                 | Status stays `confirmed` |
| 9.5 | Late read after canceled       | `read`                      | `canceled`                  | Status stays `canceled`  |
| 9.6 | Late status after no-reply     | `delivered`/`read`/`failed` | `no_reply`                  | Status stays `no_reply`  |

## 10. Follow-Up Automation

| #    | Case                         | Precondition                             | Expected                                                                                    |
| ---- | ---------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| 10.1 | Follow-up sent               | `followUpEnabled`, no reply within delay | Follow-up sent, `followUpSentAt` set, `followUpAttempts` incremented, `waMessageId` updated |
| 10.2 | Follow-up disabled           | `followUpEnabled = false`                | Worker skips                                                                                |
| 10.3 | Already replied              | Status is `confirmed`/`canceled`         | Worker skips                                                                                |
| 10.4 | Already followed up          | `followUpAttempts > 0`                   | Worker skips                                                                                |
| 10.5 | Follow-up send failure       | WhatsApp API error                       | Metadata recorded, verification **not** marked `failed`                                     |
| 10.6 | Follow-up plan limit         | Quota exhausted                          | Metadata recorded, verification not failed                                                  |
| 10.7 | Follow-up during quiet hours | Quiet hours active                       | Job rescheduled outside quiet window                                                        |

## 11. No-Reply Escalation

| #    | Case                          | Precondition                            | Expected                                   |
| ---- | ----------------------------- | --------------------------------------- | ------------------------------------------ |
| 11.1 | Escalation fires              | `escalationDelayMinutes > 0`, no reply  | Status → `no_reply`, tag `Akeed: No Reply` |
| 11.2 | Escalation disabled           | `escalationDelayMinutes = 0`            | No escalation job scheduled                |
| 11.3 | Already terminal              | Status `confirmed`/`canceled`/`failed`  | Worker skips                               |
| 11.4 | Merchant already canceled     | `merchantCanceledAt` set                | Worker skips                               |
| 11.5 | Follow-up pending             | Follow-up enabled but not yet attempted | Escalation pushed behind follow-up         |
| 11.6 | Escalation during quiet hours | Quiet hours active at execution time    | Job rescheduled                            |

## 12. Merchant No-Reply Cancellation

| #    | Case                      | Precondition                                | Expected                                                                                                                                                                   |
| ---- | ------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 12.1 | Successful cancel         | Status `no_reply`, valid Shopify order      | Shopify order canceled (`reason=CUSTOMER`, `restock=true`), status → `canceled`, `cancellationSource = merchant_no_reply`, `merchantCanceledAt` set, tag `Akeed: Canceled` |
| 12.2 | Idempotent re-cancel      | Already `canceled` with `merchant_no_reply` | Returns success without side effects                                                                                                                                       |
| 12.3 | Wrong status              | Status is not `no_reply`                    | Rejected                                                                                                                                                                   |
| 12.4 | Shopify cancel fails      | Shopify API error                           | Local state **not** changed                                                                                                                                                |
| 12.5 | Race condition            | Status changed between pre-check and update | Re-checks idempotency; returns bad request if not merchant-canceled                                                                                                        |
| 12.6 | Tag failure after cancel  | Shopify tagging fails                       | Cancellation still succeeds (Shopify cancel is irreversible)                                                                                                               |
| 12.7 | Missing external order id | No `externalOrderId`                        | Rejected                                                                                                                                                                   |

## 13. Quiet Hours

| #    | Case                              | Precondition                                        | Expected                          |
| ---- | --------------------------------- | --------------------------------------------------- | --------------------------------- |
| 13.1 | Job scheduled inside quiet hours  | `quietHoursEnabled = true`, due time in window      | Due time moved to `quietHoursEnd` |
| 13.2 | Job scheduled outside quiet hours | `quietHoursEnabled = true`, due time outside window | Due time unchanged                |
| 13.3 | Quiet hours disabled              | `quietHoursEnabled = false`                         | No adjustment                     |

## 14. Settings Validation

| #    | Case                               | Input                                                                           | Expected                               |
| ---- | ---------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------- |
| 14.1 | Valid settings                     | All controls within bounds                                                      | `PATCH /api/onboarding/settings` → 200 |
| 14.2 | Follow-up delay ≥ escalation       | `followUpDelayMinutes = 400`, `escalationDelayMinutes = 360`, follow-up enabled | Rejected (cross-field rule)            |
| 14.3 | Quiet hours enabled, missing times | `quietHoursEnabled = true`, no `quietHoursStart`                                | Rejected                               |
| 14.4 | Send delay out of range            | `sendDelayMinutes = 2000`                                                       | Rejected (max 1440)                    |
| 14.5 | Invalid timezone                   | Timezone not in `AUTOMATION_TIMEZONES` allowlist                                | Rejected                               |

## 15. Dashboard & KPIs

| #    | Case                     | Action                                         | Expected                                                                    |
| ---- | ------------------------ | ---------------------------------------------- | --------------------------------------------------------------------------- |
| 15.1 | Stats load               | `GET /api/verifications/stats` with date range | Returns confirmed, canceled, awaiting, reply rate, confirmation rate, usage |
| 15.2 | Status filter — awaiting | Filter "awaiting response"                     | Backend receives `status=pending,sent,delivered,read`                       |
| 15.3 | Test send                | `POST /api/verifications/test`                 | Test verification sent, no Shopify tag on reply                             |
| 15.4 | Money saved KPI          | Canceled count = 5, `avgShippingCost = 3`      | Savings = 15                                                                |

## 16. Billing & Usage

| #    | Case                                | Precondition                                 | Expected                                  |
| ---- | ----------------------------------- | -------------------------------------------- | ----------------------------------------- |
| 16.1 | Usage consumed on send              | Successful WhatsApp send                     | Usage count incremented                   |
| 16.2 | Usage released on failure           | Send fails                                   | Usage reservation released                |
| 16.3 | Delayed send — no early consumption | `sendDelayMinutes > 0`, verification created | Usage **not** consumed until worker sends |
| 16.4 | Follow-up consumes usage            | Follow-up sent                               | Usage count incremented                   |
| 16.5 | Limit reached mid-period            | Quota exhausted                              | Further sends blocked, status → `failed`  |
