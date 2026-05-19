# Order Confirmation Workflow — Test Cases

Derived from [ORDER_CONFIRMATION_WORKFLOW.md](ORDER_CONFIRMATION_WORKFLOW.md).

---

## 5. Initial Send — Immediate

| #   | Case               | Precondition                     | Expected                                                                        |
| --- | ------------------ | -------------------------------- | ------------------------------------------------------------------------------- |
| 5.3 | Plan limit reached | Included confirmations exhausted | Status → `failed`, metadata `{ reason: 'plan_limit_reached', kind: 'initial' }` |

## 16. Billing & Usage

| #    | Case                     | Precondition    | Expected                                 |
| ---- | ------------------------ | --------------- | ---------------------------------------- |
| 16.5 | Limit reached mid-period | Quota exhausted | Further sends blocked, status → `failed` |
