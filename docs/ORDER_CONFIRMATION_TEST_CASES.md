# Order Confirmation Workflow — Test Cases

Derived from [ORDER_CONFIRMATION_WORKFLOW.md](ORDER_CONFIRMATION_WORKFLOW.md).

---

## 5. Initial Send — Immediate

| #   | Case               | Precondition                     | Expected                                                                        |
| --- | ------------------ | -------------------------------- | ------------------------------------------------------------------------------- |
| 5.3 | Plan limit reached | Included confirmations exhausted | Status → `failed`, metadata `{ reason: 'plan_limit_reached', kind: 'initial' }` |

## 11. No-Reply Escalation

| #    | Case                          | Precondition                            | Expected                           |
| ---- | ----------------------------- | --------------------------------------- | ---------------------------------- |
| 11.2 | Escalation disabled           | `escalationDelayMinutes = 0`            | No escalation job scheduled        |
| 11.5 | Follow-up pending             | Follow-up enabled but not yet attempted | Escalation pushed behind follow-up |
| 11.6 | Escalation during quiet hours | Quiet hours active at execution time    | Job rescheduled                    |

## 16. Billing & Usage

| #    | Case                                | Precondition                                 | Expected                                  |
| ---- | ----------------------------------- | -------------------------------------------- | ----------------------------------------- |
| 16.1 | Usage consumed on send              | Successful WhatsApp send                     | Usage count incremented                   |
| 16.2 | Usage released on failure           | Send fails                                   | Usage reservation released                |
| 16.3 | Delayed send — no early consumption | `sendDelayMinutes > 0`, verification created | Usage **not** consumed until worker sends |
| 16.4 | Follow-up consumes usage            | Follow-up sent                               | Usage count incremented                   |
| 16.5 | Limit reached mid-period            | Quota exhausted                              | Further sends blocked, status → `failed`  |
