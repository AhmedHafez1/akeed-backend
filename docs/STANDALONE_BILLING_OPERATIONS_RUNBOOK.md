# Standalone billing operations runbook

Staff procedures for inspecting and reconciling Standalone credit accounts in the admin console (`/[locale]/admin/standalone-billing`) and its API (`/api/admin/standalone-billing`). Introduced by [US-04.5-06](Epics/04.5-standalone-paymob-usage-billing/US-04.5-06-staff-billing-operations.md).

Nothing here can mark a payment successful, delete or edit a ledger entry, change a provider identifier or issue a Paymob refund. Those actions do not exist in the console or the API.

## Who may do what

| Capability | Requirement |
| --- | --- |
| List, filter and open accounts; take adjustment and repair previews | Staff session: `ADMIN_CONTROL_TOWER_ENABLED`, `akeed_role = admin`, AAL2 when `ADMIN_REQUIRE_AAL2` |
| Apply an adjustment or repair, resolve a send, ask Paymob, record refund or dispute evidence | The above **and** `STANDALONE_BILLING_OPERATIONS_ENABLED=true` **and** the staff user id listed in `STANDALONE_BILLING_OPERATOR_IDS` |

Merchant organization roles (owner, admin, viewer) grant nothing here. An adjustment or repair preview can only be applied by the staff member who took it.

Writes are throttled to 10 per minute per client on top of the console's 30 per minute.

**Dual control is not enforced by software.** One named operator can preview and apply. If finance requires a second approver, record it in the ticket before the operator applies, and have the second person review the account's staff audit trail afterwards. Enforcing it in the console is a separate change.

## Evidence to record

Every write takes a reason (required, 500 characters) and is audited with the actor, request id and before/after figures. Reasons and evidence are stored in the audit row and ledger entry and are never logged. Never paste card numbers, wallet numbers, customer phone numbers or credentials.

| Operation | Required evidence |
| --- | --- |
| Credit adjustment | Ticket or finance approval reference; why the balance is wrong |
| Resolve send as accepted | Meta message id (`wamid.…`) and where it was confirmed |
| Resolve send as not accepted | Meta shows no record, and where that was checked |
| Paymob inquiry | Why it is being asked (merchant report, stale pending purchase) |
| Refund or dispute evidence | Paymob refund or dispute id, the cumulative refunded total or disputed amount, and the dashboard record it was copied from |
| Projection repair | Incident reference and what caused the drift |
| Reconciliation run | Incident, finance close, or investigation reference |
| Settlement summary/correction | Paymob report id, covered UTC period, settlement timestamp, finance evidence location, and correction reason |

Settlement evidence is access-controlled at its referenced location; the console stores only the bounded evidence reference and never writes it to Railway logs.

## Reading an account

Open **Open** on a row, or filter first: *Balance* (low, no credits, debt), *Account status* and *Reconciliation → Needs reconciliation* (flagged purchases, unresolved sends, or a projection that no longer matches its ledger).

- **Ledger reconciliation** compares the posted balance with the ledger total, and held credits with held reservations. Both must match.
- A **yellow alert** means the projection drifted. Every write except projection repair is refused with `CREDIT_PROJECTION_MISMATCH` until it is repaired. Callbacks for the account are frozen too.
- A **red alert** names contradictory records (for example, a credit still held for a send that was already settled). Every write, including repair, is refused. Escalate to engineering with the organization id and the listed references; do not try to work around it.

## Procedures

### Adjust credits

1. Enter a signed whole number (±10,000 at most) and **Preview**. Review available, posted, held and debt before and after. A negative adjustment can create debt, which blocks new sends.
2. Enter the reason and **Apply**. The request carries one idempotency key for this preview; retrying after a network error cannot post twice.
3. `BILLING_PREVIEW_STALE` means a send, payment or other change moved the account after your preview. Preview again and re-check the figures.

Accounts pending approval cannot be adjusted; approve them first. Adjustments are `staff_adjustment` ledger entries; reverse one with an opposite adjustment, never by editing data.

### Resolve an unknown send

Unresolved sends hold one credit each. Only sends in *Outcome unknown* can be resolved.

- **Accepted** consumes the held credit. It requires the Meta message id.
- **Not accepted** releases the credit, marks the verification failed and allows the next attempt.

The credit moves exactly once; resolving the same way again reports that it was already done, and resolving the other way is refused.

### Ask Paymob about a purchase

Available for a pending purchase, or one flagged for reconciliation after failing, being canceled or expiring. Akeed asks with the identifiers it stored, and only Paymob's verified answer can change the purchase. Outcomes: *resolved* (applied like a callback), *expired* (only when the checkout window has passed and Paymob has no record), or *deferred* (Paymob could not say; the purchase stays flagged and backs off).

### Record a refund or dispute

Available for successful and refunded purchases.

- **Refund:** enter the **cumulative** refunded total Paymob shows, not the latest refund alone, plus the refund id. A total that maps to whole credits reverses them (a full refund marks the purchase refunded). A total that does not map to whole credits is recorded and flagged `partial_refund_not_whole_credit` with no credit change.
- **Chargeback opened / lost:** reverses the purchased credits not already reversed, once. Use the full purchase amount; a partial dispute is flagged `staff_evidence_mismatch` for finance.
- **Chargeback won:** use the **same dispute id**. Reinstates exactly what the chargeback took, once.
- A currency or amount that does not match the purchase, or a missing provider id, is flagged for review and changes no credits. Re-submitting the same evidence is a no-op.

Reversals can leave the merchant in debt. That blocks new sends until they buy credits or finance approves an adjustment.

### Repair a drifted projection

1. Confirm the drift in the yellow alert and find its cause (a manual SQL change, a partial restore). Record the incident.
2. **Preview repair.** It shows the posted balance rebuilt from the ledger and the held count from held reservations. If it reports contradictory records, stop and escalate.
3. Enter the reason and **Apply repair**. Only the projection changes; the ledger is never touched. The audit row records before, after, difference, reason, request and actor.

### Run reconciliation

The `billing-reconciliation` queue has one worker and a nightly `30 2 * * *` schedule in `Africa/Cairo`. A named operator may enter a reason and select **Run reconciliation**. Reusing or retrying the same queue job continues the durable run and skips completed target attempts.

Keep `STANDALONE_BILLING_SCHEDULED_INQUIRY_ENABLED=false` during initial rollout. Local ledger, reservation, contradiction, settlement, health, metric, and retention checks still run. Set it to `true` only after Paymob inquiry access has been exercised. Keep `STANDALONE_BILLING_RECONCILIATION_REPORT_ONLY=true` until comparisons are clean; report-only inquiries persist findings but cannot change purchases or credits. The existing account-level staff inquiry remains available regardless of the scheduled-inquiry switch.

### Enter or correct a settlement

1. In **Paymob settlement summaries**, copy the report id, exact covered timestamps, settlement timestamp, EGP transaction count, gross, refunds, chargebacks, fees, VAT, and net. Decimal UI values are converted to integer piastres before submission.
2. Attach a bounded finance evidence reference and reason. Do not paste the report contents or customer/payment data.
3. Submit once. A required `Idempotency-Key` makes a network retry safe, and the accepted entry immediately queues reconciliation.
4. To correct an error, select **Correct revision** on the current effective row. Never edit or delete the original. The correction records `supersedesId` plus the next revision.
5. A one-piastre or one-transaction difference is a finding. Settlement input never grants credits or changes a purchase.

Net revenue, ARPPU, fees, VAT, and revenue per accepted message show as unavailable unless effective settlement reports fully cover the selected bounded period. All-time is intentionally not claimed complete.

## Outage response

| Failure | Immediate action | Recovery proof |
| --- | --- | --- |
| Callback/HMAC spike | Confirm the callback path and clock, preserve a sanitized fingerprint sample, and compare the Paymob HMAC secret without logging it. Never bypass verification. | Valid sandbox callback accepted; invalid HMAC rejected; no duplicate grant. |
| Callback database failure | Keep returning non-2xx so Paymob retries. Restore PostgreSQL, then reconcile affected references. | Event, purchase, grant, and projection commit atomically once. |
| Paymob inquiry timeout/rate limit | Leave the `provider_inquiry_deferred` finding open. Scheduled runs skip it until its `nextAttemptAt` (15 minutes, doubling per failure, capped at 24 hours); do not repeatedly click inquiry. | A later bounded inquiry resolves it, or the finding keeps its retry count and next action. |
| Redis/queue outage | Callbacks continue through synchronous canonical ingestion. Restore Redis, verify scheduler state, then enqueue one named manual run. | One durable run completes and incomplete targets resume without duplicate attempts. |
| PostgreSQL outage | Stop staff writes and scheduled work; restore the database before replaying callbacks or jobs. | Invariants pass and a full scan completes before unseen findings resolve. |
| Stale pending payment | Use the existing inquiry. Never expire or grant from elapsed time, screenshots, or settlement input. | Paymob confirms a canonical terminal state or the finding stays open. |
| Trusted-field mismatch/unknown reference | Quarantine and investigate reference, amount, currency, integration, mode, and ownership. | Matching provider evidence is ingested, or finance resolves without a grant. |
| Projection mismatch | Stop mutations, inspect contradictions, then use the existing preview/apply repair. | `checkInvariant` passes and the next full scan resolves the finding. |
| Refund, chargeback, or debt | Follow the provider-evidence procedure; involve finance/support for debt recovery or an approved adjustment. | The original paid batch and immutable reversal/reinstatement entries reconcile. |

Failed or partial full scans never resolve findings that were not seen. Poison findings remain open with their prescribed next action and retry schedule. A run whose worker died is continued by BullMQ's stalled-job redelivery or the next retry of the same job; completed accounts, purchases, signals, and settlement comparisons are skipped, and a purchase already asked about in that run is never asked again.

## Railway alerts and retention

Create Railway log alerts against structured JSON where `action="standalone-billing-alert"`:

| Alert | `alertCode` | Condition |
| --- | --- | --- |
| Invalid Paymob HMAC | `invalid_hmac` | At least 5 events in 5 minutes (refusals while billing is disabled are not counted) |
| Integrity failure | `trusted_data_mismatch`, `callback_failure`, `provider_success_without_grant`, `grant_without_verified_success`, `projection_mismatch`, `source_contradiction`, `duplicate_provider_id`, `duplicate_grant_attempt` | Any event |
| Paymob slow | `paymob_slow` | Any provider call over 5,000 ms |
| Paymob degraded | `paymob_error_rate` | Error rate at least 20% across at least 5 attempts in 24 hours |
| Reconciliation backlog | `reconciliation_backlog` | At least 25 open findings or oldest open finding at least 120 minutes |
| Finance risk | `refund_state`, `chargeback_state`, `credit_debt`, `refund_dispute_discrepancy`, `settlement_difference` | Any newly opened finding |
| Stale or deferred payment | `stale_pending`, `provider_inquiry_deferred` | Any newly opened finding |

Reconciliation findings alert once when they open (or reopen), not on every run that sees them again.

Organization and sanitized provider references may be searchable log fields, but never metric dimensions. `standalone-billing-metric-summary` contains bounded counters only. Configure Railway for at least 30 days of searchable log retention.

Nightly cleanup retains completed runs and attempts for 180 days and resolved findings for 365 days. Open findings, settlement reports and corrections, purchases, provider events, ledger entries, and audit rows are never deleted by this cleanup.

## Credential rotation

Rotate Paymob server/public/HMAC keys and integration ids through Railway secrets; never paste them into tickets or logs. During HMAC rotation coordinate the provider cutover so one deployed secret matches the callback. Keep checkout disabled if credentials are uncertain, verify a sandbox intention, callback, inquiry, and refund, and then restore traffic. Rotation does not authorize deletion or rewriting of durable billing evidence.

## Escalation

| Situation | Escalate to | Notes |
| --- | --- | --- |
| Contradictory records | Engineering | Include organization id, contradiction codes and references |
| Drift that returns after repair | Engineering | Something is writing outside the posting path |
| Debt after a refund or chargeback | Finance, then merchant support | Agree whether to recover by purchase or waive by adjustment |
| Open or lost chargeback | Finance | Track the dispute id until Paymob reports the result |
| Partial refund or partial dispute | Finance | Decide the credit treatment; apply it as an adjustment with the finance reference |
| A payment the merchant says succeeded but Paymob does not confirm | Paymob support via finance | Never grant credits manually for an unverified payment |

## Recovery drill (before naming operators)

Run in a non-production environment with the switch on and one operator named:

1. Adjust +10 and −10 on a test account; confirm two ledger entries, two audit rows and an unchanged net balance.
2. Retry an apply with the same key and confirm it reports a duplicate.
3. Create an outcome-unknown send, resolve it as not accepted, and confirm the next attempt can be claimed.
4. Ask Paymob about a stale sandbox purchase.
5. Record a whole-credit refund, then a chargeback opened and won with one dispute id; confirm the ledger returns to its starting balance plus the refund reversal.
6. Drift a test projection with SQL, confirm writes are refused, preview and apply the repair, and confirm writes work again.
7. Confirm a non-operator staff session can inspect and preview but every apply control is disabled and the API answers `STANDALONE_BILLING_OPERATOR_REQUIRED`.

## Rollout and rollback

1. Deploy with `STANDALONE_BILLING_OPERATIONS_ENABLED=false`: read-only inspection and previews only.
2. After the drill, set the switch to `true` and list the named operators in `STANDALONE_BILLING_OPERATOR_IDS`.
3. Roll back by setting the switch to `false`. Ledger entries, purchases, provider events, reservations and audit rows are preserved; only new staff writes stop.

## Error codes

| Code | Meaning |
| --- | --- |
| `STANDALONE_BILLING_OPERATIONS_DISABLED` | The write switch is off |
| `STANDALONE_BILLING_OPERATOR_REQUIRED` | The staff member is not a named operator |
| `CREDIT_PROJECTION_MISMATCH` | Projection drifted; repair first |
| `CREDIT_SOURCE_CONTRADICTORY` / `REPAIR_SOURCE_CONTRADICTORY` | Records contradict each other; escalate |
| `BILLING_PREVIEW_STALE` | The account changed after the preview |
| `BILLING_PREVIEW_ALREADY_APPLIED` / `BILLING_IDEMPOTENCY_CONFLICT` | The preview or key was already used for a different apply |
| `BILLING_ACCOUNT_NOT_APPROVED` | Approve the organization first |
| `BILLING_DISPATCH_NOT_FOUND` / `BILLING_PURCHASE_NOT_FOUND` | Not found **for this organization** (another tenant's id answers the same way) |
| `BILLING_DISPATCH_NOT_CREDIT_BILLED` | The send is on periodic accounting; use the generic resolver |
| `BILLING_PURCHASE_NOT_ELIGIBLE` | Inquiry cannot change this purchase |
| `MESSAGE_DISPATCH_RESOLUTION_CONFLICT` | The send was already resolved differently |
