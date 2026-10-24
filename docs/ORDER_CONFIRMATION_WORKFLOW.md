# Order Confirmation Workflow And Controls

Last updated: 2026-10-01

## Purpose

This document explains the Akeed cash-on-delivery order confirmation feature from a business perspective. It covers the order lifecycle, merchant controls, backend services, frontend screens, data model, API contracts, and operational behavior.

The feature verifies COD orders through WhatsApp before the merchant fulfills the order. Orders enter from three channels: the Shopify `orders-create` webhook, a manual order created in the Standalone dashboard (see `MANUAL_ORDER_CREATION.md`), and a CSV/XLSX bulk import (see `BULK_ORDER_IMPORT.md`). Every channel produces the same normalized order and follows the same lifecycle below. Customers can confirm or cancel from a WhatsApp template. If they do not reply, Akeed can escalate the order to `no_reply`. For Shopify orders it also tags the Shopify order, and the merchant can cancel the order from the Akeed dashboard.

Merchants can now choose branded confirmation template variants per language. Messages go out in Arabic, English, Urdu, Spanish and French; Turkish is in the language list too, with drafts awaiting Meta approval, so it sends nothing until staff launch it. The selected variants are used for both preview and actual sends.

## Scope

In scope:

- Shopify `orders-create` webhook ingestion.
- Standalone order ingestion: manual orders and CSV/XLSX bulk import.
- COD eligibility filtering.
- Auto-verification enable/disable control.
- Initial WhatsApp verification message.
- Optional delayed initial send.
- Optional follow-up message.
- Quiet-hours scheduling.
- No-reply escalation.
- Customer confirm/cancel replies.
- Shopify order tagging (Shopify source only; Standalone results stay in Akeed).
- Merchant cancellation for `no_reply` orders.
- Dashboard KPIs, filters, actions, and settings controls.
- Billing usage consumption for verification sends.

Out of scope:

- Creating Shopify orders before checkout submission.
- Automatically canceling Shopify orders on a customer cancel reply. The current customer cancel flow marks and tags the order, but does not call Shopify order cancellation.
- How an EasyOrders or WooCommerce order arrives and how its outcome is written back to the store. Both feed the same lifecycle described here; their ingestion and outcome synchronization are in [Integrations, Webhooks, And Automation](INTEGRATIONS_WEBHOOKS_AND_AUTOMATION.md#easyorders-connection).

## Lifecycle States

| Status      | Meaning                                                                            | Main writer                                         |
| ----------- | ---------------------------------------------------------------------------------- | --------------------------------------------------- |
| `pending`   | Verification record exists, but the first WhatsApp template has not been sent yet. | `VerificationHubService`                            |
| `sent`      | Initial WhatsApp verification template was sent successfully.                      | `VerificationMessageDispatchesRepository`           |
| `delivered` | Meta reported delivery for the current WhatsApp message id.                        | `WhatsAppWebhookService`                            |
| `read`      | Meta reported the message was read.                                                | `WhatsAppWebhookService`                            |
| `confirmed` | Customer pressed the confirm button.                                               | `WhatsAppWebhookService`                            |
| `canceled`  | Customer canceled, merchant canceled after no reply, or Akeed canceled it automatically (`automatic_no_reply`). | `WhatsAppWebhookService`, `VerificationsService`, `AutoCancellationService` |
| `no_reply`  | Customer did not respond before the escalation job fired.                          | `VerificationAutomationProcessor`                   |
| `no_whatsapp` | The customer number cannot receive WhatsApp (Meta error 131026). The merchant calls the customer. | `WhatsAppWebhookService`, `VerificationSendService` |
| `blocked`   | The order arrived after the plan allowance or the prepaid credits ran out. Nothing was sent or charged; recovery sends it once capacity is back. | `VerificationHubService` |
| `failed`    | Initial send failed, or a blocked order waited longer than the age limit.          | `VerificationSendService`, `VerificationHubService`, `CapacityRecoveryService` |
| `expired`   | Reserved enum value for lifecycle compatibility.                                   | Not actively automated in this workflow             |

### Number not on WhatsApp

Meta reports error `131026` when the customer number cannot receive WhatsApp messages: the number is not on WhatsApp, or its owner has not accepted the current terms or runs an outdated app. It usually arrives as a `failed` status webhook with `errors[0].code = 131026`, and sometimes as the synchronous error of the send call. `classifyDeliveryFailure` (`src/shared/verification/delivery-failure.policy.ts`) is the one place that recognizes it; every other code keeps the generic `failed` / `provider_delivery_failed` handling.

On either path the verification moves to `no_whatsapp`, with `no_whatsapp_at` (first report, never overwritten) and `delivery_error_code`:

- The update is guarded on `delivered_at IS NULL AND read_at IS NULL`, so a report that arrives after a delivery or read receipt leaves the row as it is.
- `no_whatsapp` is in `WEBHOOK_PROTECTED_STATUSES`, so a duplicate or late receipt matches no row. Only the write that made the transition triggers the follow-through.
- A report that beats the acceptance is parked in `provider_message_receipts` and applied when the acceptance is recorded; `scheduleFollowUpAndEscalation` then finds the row at `no_whatsapp` and runs the follow-through instead of scheduling.

The follow-through is `VerificationHubService.markNoWhatsApp`. It removes the delayed `follow-up-1` and `no-reply` jobs (`VerificationAutomationProducer.cancelPendingReminders`, best effort; `no_whatsapp` is also in `AUTOMATION_FINAL_STATUSES`, so a job that survives does nothing), clears `metadata.follow_up_due_at`, and dispatches `automatic_no_whatsapp_tagging`. Shopify adds the tag `Akeed: No WhatsApp`; Standalone records it locally; EasyOrders and WooCommerce answer `unsupported`, as they do for no-reply tagging. It never throws.

Usage: the failed receipt returns the periodic-plan usage and reverses the prepaid credit exactly as for any undelivered message (once, never after a delivery). A synchronous 131026 resolves the dispatch as not accepted, which releases the usage or the credit hold in both accounting modes.

The merchant sees the row under the `no_whatsapp` tab and in `needs_action` (reason `no_whatsapp`). Manual confirmation and merchant cancellation are offered; retry is not, because a resend fails the same way. A merchant cancellation of a `no_whatsapp` row records `cancellation_source = merchant_no_whatsapp` (instead of `merchant_no_reply`) and cancels the order in the store the same way. Rows that were already `failed` with code 131026 before this status existed stay `failed`.

### Orders blocked by capacity

An eligible order that arrives after the plan allowance or the prepaid credits ran out is still created. Its verification is `blocked`, with `metadata.reason` set to `plan_limit_reached`, `INSUFFICIENT_CREDITS` or `CREDIT_DEBT_OUTSTANDING`. The same happens when the slot check or the dispatch ledger's claim refuses an initial send for capacity. Nothing is sent and no usage or credit is taken. No reminder or no-reply escalation is scheduled (`blocked` is in `AUTOMATION_FINAL_STATUSES`), so a blocked order is never treated as unanswered. A refusal for any other reason (suspended account, inactive subscription, auto-verify off) still skips the order. The onboarding test message is never blocked.

Recovery (`modules/capacity-recovery`) sends an organization's blocked orders, oldest first, once capacity is back. It is a job on the `capacity-recovery` queue, deduplicated per organization, requested:

- after a credit purchase is granted, once its transaction has committed;
- after a Shopify plan is activated, or an `app_subscriptions/update` reports the subscription active;
- by a sweep every 10 minutes for each organization with blocked orders. The sweep covers the allowance reset (a period has no reset event), staff credit adjustments and lost triggers.

`CapacityRecoveryService` checks each order again just before sending it:

1. **Age.** An order older than `BLOCKED_ORDER_MAX_AGE_HOURS` (default 24, counted from the order's creation) moves to `failed` with reason `capacity_block_stale` and the original reason in `metadata.blocked_reason`. It is not sent. It shows in needs-action as `send_failed`, where the merchant can retry, confirm or cancel it.
2. **Source.** A source that is gone, paused, not onboarded or refused by its entitlement keeps its orders blocked.
3. **Capacity.** When `hasAvailableSlot` says no, the run stops.
4. **Reopen.** `reopenRetryableInitialFailure` is a single status-guarded update. Only one worker wins it; the other skips the order. Recovery marks the order as handed over (`metadata.capacity_resumed_at`, with the reason it waited for in `metadata.blocked_reason`).
5. **Send.** `VerificationHubService.resumeInitialSend` takes the ordinary initial-send path (send delay, quiet hours) and the dispatch ledger, which claims usage or a credit hold once per message. If the send is refused for capacity anyway, the order is blocked again and the run stops.

If the send or the enqueue throws after the reopen, the order is blocked again at once and the job fails, so BullMQ retries it. If the process dies in between, the order is left `pending` with nothing to send it; each run, and the sweep, block such an order again once it has been handed over for 15 minutes with no live initial dispatch and no send scheduled later (`returnStrandedCapacityResumes`). A delayed initial send that already ran keeps its job id for days, so scheduling it again removes the finished job first (`VerificationAutomationProducer.enqueueInitialSend`); this also covers a merchant retry of a delayed send.

A run reads candidates 50 at a time past a cursor (creation time, then id), up to 10 pages, so orders that must wait for their source never hide newer ones that can be sent. When the pages run out with capacity left, the run enqueues a continuation that starts from its cursor, under its own deduplication id: the org's key is still held by the running job, and BullMQ would drop a second job under it. Two runs at once can neither send an order twice nor charge it twice. Rows that failed for capacity before `blocked` existed (`failed`, a capacity reason, never sent) are picked up the same way while they are within the age limit. The merchant can also retry a blocked order from the table; it goes through the same reopen.

The dashboard overview returns `capacity`: `blocked_count`, `mode` (`plan` or `credits`), `remaining`, `action` (`upgrade`, `recharge` or `wait_reset`) and `reset_at`. The dashboard shows a banner while `blocked_count` is above zero. Alert emails are described in [ONBOARDING_AND_BILLING.md](ONBOARDING_AND_BILLING.md#usage-alerts).

**Limitation:** Akeed does not observe cancellations or fulfilments made in the store. An order cancelled there while it was blocked is still sent when capacity returns, unless it is past the age limit. That is why the limit is short.

### Automatic cancellation of unanswered orders

A store may switch on `autoCancelEnabled` (off by default). An order that then reaches `no_reply` is canceled in its store, but only when the customer demonstrably had the chance to answer. The reason recorded is "No response after confirmation attempts" (`cancellation_source = automatic_no_reply`). It runs at the moment the order reaches `no_reply`, so the escalation delay is the deadline and there is no timing rule of its own; the escalation already waits for quiet hours to end. The switch needs `escalationEnabled`, and switching the escalation off switches it off too.

**Decision.** `VerificationAutomationProcessor.handleEscalateNoReply` calls `AutoCancellationService.scheduleAfterNoReply` only after its own `no_reply` write returned a row. The pure `evaluateAutoCancel` (`src/shared/verification/auto-cancel.policy.ts`) answers:

| Answer | When |
| --- | --- |
| `schedule` | The first dispatch has a delivery or read receipt; a reminder that was attempted has one too; no message ever came from the customer; the merchant did not exclude the order. Due at once. |
| `pause` | `initial_not_delivered`, `reminder_blocked` (`follow_up_skipped` / `follow_up_failed`: plan limit, credits, template, send failure), `reminder_not_delivered`. A paused row is re-checked by the sweep for 7 days, so a receipt that arrives late resumes it. Capacity is never a reason to cancel. |
| `skip` | The setting is off, a test order, excluded, already answered or settled, or the customer wrote. A disabled store or a test order gets no row at all. |

**State.** One `verification_auto_cancellations` row per verification (unique `verification_id`): `scheduled | paused | in_progress | awaiting_platform | succeeded | failed | skipped | stopped`, with `reason`, `due_at`, `attempts`, `lease_until`, `provider_operation_id`, the restock and notify choices snapshotted at dispatch, `dispatched_at`, `completed_at` and `late_reply_at`. Every decision appends to `verification_auto_cancellation_events` (`actor_user_id` NULL is Akeed).

**Execution** (`auto-cancellation` queue, `AutoCancellationService.execute`). Every step runs under `withLockedVerification`: the verification row is locked first and the cancellation row second, on every path.

1. Claim: a due `scheduled` row, or an `in_progress` one whose 5-minute lease ran out. The rules are evaluated again; a rule that no longer holds stops or pauses the row. The claim sets `in_progress`, the lease and `attempts + 1`. A duplicate job finds the row claimed and exits.
2. Read the store: `CommerceOutcomeRegistryService.inspectForCancellation`. `already_canceled` counts as success with no second cancel. `not_cancellable` (`paid`, `fulfilled`, `fulfillment_in_progress`, `status_not_writable`, `order_not_found`) skips the row.
3. Mark the dispatch under the lock after one more check of the customer, the exclusion and the setting. After this mark nothing the customer or the merchant does changes the order.
4. Dispatch `automatic_no_reply_cancellation` with `cancellation: { restock, notifyCustomer, staffNote }`.
5. `applied` (WooCommerce and EasyOrders confirm by reading the order back; Standalone is local) finishes at once. Shopify's `orderCancel` returns a job: the row waits in `awaiting_platform` and the confirm job polls `job { done }`, then reads the order, and fails with `platform_confirmation_timeout` after 30 minutes. A retryable failure backs off 30s, 2m, 8m, 30m and fails after the fifth attempt; a permanent one fails at once.
6. Finish: one update guarded on `status = 'no_reply'` moves the verification to `canceled` with the automatic source and the operation in `metadata.commerceCancellation`; the row becomes `succeeded`; `merchant_cancellation_tagging` runs best effort. Nothing is marked canceled before the store shows it.

The sweep (every 5 minutes) enqueues due rows whose job was lost, resumes expired leases, polls `awaiting_platform` rows and re-checks paused ones.

**Customer messages.** `WhatsAppWebhookService` records every inbound message before it reads it (`VerificationAutoCancellationsRepository.recordCustomerMessage`): the order its button or quote names gets `customer_last_message_at`, and only that order. A message that names no order (plain text, media, or a quote Akeed cannot match) is recorded on every open order sent to that number in the last 7 days, in any store. A `scheduled` or `paused` row stops (`customer_reply`); an `in_progress`, `awaiting_platform` or `succeeded` row gets `late_reply_at`, and the reply does not change that order's status.

**Needs action.** `customer_replied` (an open order the customer wrote about without a clear answer, whatever the setting), `auto_cancel_failed` and `late_reply_after_auto_cancel`. The merchant may still cancel a `no_reply` order with `customer_replied` or `auto_cancel_failed` by hand; the manual cancel answers `409 AUTO_CANCEL_ALREADY_IN_PROGRESS` while the automatic one is committed.

**Merchant controls.** `POST /api/verifications/:id/auto-cancel/exclude` and `/include` (owner or admin, idempotent, audited; unavailable once the verification is `no_reply`, confirmed, or canceled; `AUTO_CANCEL_ALREADY_IN_PROGRESS`, `AUTO_CANCEL_EXCLUDE_NOT_ALLOWED`). Switching the setting off stops every `scheduled` and `paused` row of the store (`feature_disabled`); switching it on again applies to orders that reach `no_reply` afterwards. The list item carries `auto_cancel: { state, scheduled_for, reason, excluded, late_reply }`, `projected` while the order is still waiting for the customer, and the capability `auto_cancel_exclusion`.

**Stores.** Shopify reads `cancelledAt`, `displayFinancialStatus` (only `PENDING`), `displayFulfillmentStatus` (only `UNFULFILLED`) and `closed`, and applies the restock and notify choices. WooCommerce cancels from `processing` or `on-hold` with no `date_paid`; EasyOrders from `pending`. Both follow the store's own stock and email settings and need their outcome-sync switch. Standalone records it in Akeed.

### Held orders (bulk import)

A bulk import creates its orders **held** before any verification exists. A held order has no verification row and no message, and it is invisible to dispatch and reconciliation until the merchant starts the import. The dashboard shows these pre-verification stages next to the lifecycle statuses above:

| Stage | Meaning |
| ----- | ------- |
| `awaiting_start` | Imported and held. Nothing has been sent. |
| `queued` | The import is releasing and this order is waiting for its turn (paced release). |
| `sending` | The order was released and is being dispatched. |
| `not_started` | The start window passed, or the import was stopped; the order was withdrawn without a message or charge. |

Once released, an imported order is indistinguishable from any other order: the same eligibility, quiet hours, follow-up, no-reply, credit and retry rules apply. See `BULK_ORDER_IMPORT.md`.

### The `pending` invariant

> A verification may hold `pending` **only** while no message has been accepted by the
> provider. Once an accepted dispatch with a `provider_message_id` exists, the row is at
> least `sent`.

`verification_message_dispatches` is the source of truth for *"did we message this
customer"*; `verifications.status` is a projection of it and must never contradict it.
This matters more than the other statuses because `pending` is a claim the merchant acts
on — it says nobody has been contacted, so a merchant who sees it phones the customer
themselves or holds a shippable COD order. It also feeds the `pending` KPI and the reply
and confirmation rates, so a wrong `pending` makes the product under-report its own
results while a message quota has already been billed.

Three rules keep the projection honest, and changes near the send path must preserve them:

- `markAccepted` projects on **every** accepted path, including a dispatch already in
  `accepted` state. It used to return early there, which permanently froze any row whose
  projection had been missed — those rows are never re-sent, so nothing else could reach
  them. The repair is idempotent and only ever raises a floor (`sentFloor`), so it cannot
  drag a `delivered`/`read` row backwards or disturb a terminal one.
- `VerificationSendService` treats an `undefined` return from `markAccepted` as a failure,
  not a send. That return means the projection did not run, so the row would keep both
  `pending` and a null `wa_message_id` — and the null id then silently breaks the delivery
  and read webhooks, which resolve against it.
- An accepted **follow-up** also carries the `sent` floor, and its delivery/read receipts
  advance the verification like any other. The terminal guard in
  `VerificationsRepository.updateStatus` is what protects a verification the customer
  already answered; dropping follow-up receipts entirely just discarded real evidence.

Migration `0029_repair_verification_status_from_dispatch_ledger.sql` restored the
invariant for rows that had already drifted, advancing each to the furthest state its
ledger row can prove (`read` > `delivered` > `sent`) and backfilling the timestamps and
`wa_message_id` with `COALESCE`. `verifications.status` is now `NOT NULL`, so the read
path no longer has a `?? 'pending'` fallback presenting "unknown" as "not sent yet".

Protected behavior:

- Terminal statuses `confirmed` and `canceled` are not overwritten by later status webhooks.
- `no_reply` is protected from late delivery/read/failed webhooks.
- A customer reply can still override `no_reply` if the merchant has not already canceled the order.
- `no_whatsapp` is protected the same way as `no_reply`: later delivery/read/failed webhooks and the escalation job leave it alone, and a customer reply still overrides it.
- If `merchantCanceledAt` is set, later customer replies are ignored.

Terminal protection is enforced at every writer, not only in
`VerificationsRepository.updateStatus`:

- `VerificationMessageDispatchesRepository` projects provider acceptance and
  rejection through a SQL `CASE` that preserves an existing terminal status. The
  send facts (`wa_message_id`, `last_sent_at`, `attempts`) are still recorded,
  because the message really was sent. This matters most for the admin
  `outcome_unknown` resolution path, which can run long after a customer replied.
- `VerificationsRepository.updateByIdForOrg` applies the terminal guard whenever
  the payload changes `status`.
- The dashboard lifecycle projection resolves `confirmed`/`canceled` ahead of
  `review_required` and `blocked`, so a settled order is never displayed as
  needing attention.

Shared vocabulary for these rules lives in
`src/shared/verification/verification-lifecycle.ts`.

### Which template a send carried

Each dispatch records the template it carried, so staff can compare
styles and tell what a customer actually received.

| Column on `verification_message_dispatches` | Holds |
| --- | --- |
| `template_variant_key` | The store's style and the resolved language, for example `ar.egyptian` |
| `template_purpose` | `initial`, `reminder`, or `test` when the order is a test order |
| `meta_template_name`, `meta_language_code` | The provider's template name and language code as sent, for example `akeed_cod_verification_direct_eg` and `ar_EG` |
| `resolved_language` | `ar`, `en`, `ur`, `es` or `fr`: the language the send resolved to, never the store's `auto` |
| `template_fallback_reason`, `template_skipped_key` | Why the store's stored choice was not the template sent (`key_unknown`, `key_inactive`, `wrong_language`, `not_approved`, `reminder_unavailable`, `auto_style_unavailable`; `order_details_missing` when the chosen template shows items or an address the order does not have), and that stored key. NULL when the choice was sent or the store had none |

- **Selected before the claim.** `selectTemplateForSend`
  (`src/shared/messaging/template-selector.ts`) picks the template from the
  template registry, the store's settings and the customer's number, and the
  claim writes it. A send whose outcome is never learned, or that the provider
  rejects, still says which template it carried.
- **From the registry.** Templates are rows of `whatsapp_templates`,
  read through `TEMPLATE_REGISTRY_PORT` (a 60-second in-memory copy). A store
  holds the registry key of its style for each language in
  `integrations.cod_template_{ar,en,ur,es,fr}_key`, for example
  `cod_confirm.ar.egyptian`. Only an active template is sent.
  - A stored key that is unknown, inactive or written for the other language
    falls back to the language default. The fallback is logged as
    `sendOnce.templateFallback` with the stored key and the reason
    (`key_unknown`, `key_inactive`, `wrong_language`), and recorded on the
    dispatch.
  - With no sendable default for the language, nothing is sent: the send returns
    `skipped` with `template_unavailable` before the dispatch is claimed, so no
    usage is reserved, and `sendOnce.templateSelection` is logged as an error.
    It never falls back to the other language. A skipped first
    send marks the verification `failed` with reason `template_unavailable`
    (retryable once a template is back), and a skipped reminder records
    `follow_up_skipped: template_unavailable`.
  - A store with no key is read from the variant columns
    `cod_template_ar_variant` / `cod_template_en_variant`, and a settings
    write sets both the key and the variant column.
  - **Guardrail.** With `WHATSAPP_TEMPLATE_GUARDRAIL_ENABLED=true`
    and the environment synced from Meta at least once, a template is sent
    only when it is active **and** approved at Meta. A selection Meta has not
    approved (paused, rejected, disabled, missing, unknown, and so on) falls
    back to the language default with reason `not_approved`; the default must
    pass the same test. The reminder resolves its template again at send time,
    so a template paused after the first send falls back or skips. Before the
    first sync, and with the switch off, only `is_active` counts. A template
    Meta re-categorized stays sendable and raises a staff alert. See
    [Template sync, status webhooks and the send guardrail](INTEGRATIONS_WEBHOOKS_AND_AUTOMATION.md#template-sync-status-webhooks-and-the-send-guardrail).
- **Confirmed at acceptance.** The messaging adapter is handed that selection and
  answers with what it sent. The acceptance transaction stamps the answer on the
  dispatch and, in the same statement that stores `wa_message_id`, writes the
  name and language code to `verifications.template_name` and `language_code`.
  Those two columns always describe the message `wa_message_id` points at, and
  are NULL until a send is accepted.
- **No placeholders.** `template_name` and `language_code` on a new dispatch hold
  the same provider name and code, never a placeholder such as
  `cod_verification` or `auto`.
- **Old rows.** Rows from before migration `0053_dispatch_template_identity.sql`
  keep the five columns NULL and are reported as "not recorded". They are never
  backfilled.

Staff read the result at
`GET /api/admin/templates/metrics?from=YYYY-MM-DD&to=YYYY-MM-DD`, across every
store and source. Add `include_test=true` to count test sends.

- For each template and language it returns the sends accepted in the range (in
  total and by purpose), how many were delivered and read, and the customer
  confirmations, customer cancellations and no-replies.
- An outcome is counted once, for the latest send accepted at or before it, so a
  reply after a reminder counts for the reminder. A merchant's own confirmation
  or cancellation is not a reply and is not counted.
- Both dates are UTC days, both included, and at most 92 days apart. A bad range
  answers `400 ADMIN_TEMPLATE_METRICS_RANGE_INVALID`.
- Sends without a recorded template are returned apart, under `not_recorded`.

### Customer-message improvements

Seven improvements, each behind its own switch and all off by default (see
[`ENVIRONMENT.md`](ENVIRONMENT.md#customer-message-improvements)).
With every switch off, the Meta payload is the one the characterization
suite pins.

- **Reminder template.** The follow-up sends the store's chosen
  `cod_reminder` template for the resolved language
  (`integrations.cod_reminder_ar_key`, `cod_reminder_en_key`). No reminder
  chosen: the follow-up sends the first-send template. A chosen
  reminder that cannot be sent falls back to the language's reminder default,
  then to the first-send template with `reminder_unavailable`. A reminder is
  never skipped only because no reminder template exists. The dispatch is
  still recorded with purpose `reminder`.
- **Arabic style by country.** A store with
  `integrations.cod_template_ar_auto = true` sends Arabic customers the
  Egyptian style for `+20`, the Gulf style for `+966`, `+971`, `+973`, `+974`,
  `+965`, `+968`, and the standard style for every other Arabic code
  (`src/shared/messaging/arabic-style.ts`). A style that cannot be sent falls
  back to the Arabic default with `auto_style_unavailable`. A store on `auto`
  with a reminder chosen gets the reminder of the same mapped style.
- **Name fallbacks.** A missing customer or store name is filled from the
  `fallback_customer_name` / `fallback_store_name` texts of the send's language
  (`whatsapp_message_texts`), never "Akeed". A missing text keeps the built-in
  word (`Customer`, `Akeed Store`) and logs `sendOnce.localizedFallback` with `message_text_unavailable`.
- **Amount.** `total` is written per language and currency
  (`src/shared/messaging/message-values.ts`): `1,250.00 ج.م` in Arabic,
  `EGP 1,250.00` in English, minor units always shown, Western digits, never
  rounded. No currency: the number alone. A value that is not a plain decimal
  is sent as stored.

  | Currency | Arabic | English |
  | --- | --- | --- |
  | EGP, SAR, AED, QAR | `1,250.00 ج.م`, `ر.س`, `د.إ`, `ر.ق` | `EGP 1,250.00` |
  | KWD, BHD, OMR (3 decimals) | `1,250.000 د.ك`, `د.ب`, `ر.ع` | `KWD 1,250.000` |
  | USD | `1,250.00 $` | `USD 1,250.00` |
  | Unknown code, for example XYZ | `1,250.00 XYZ` | `XYZ 1,250.00` |

- **Acknowledgment and nudge.** Free-form texts, sent once and never
  retried, after the verification's outcome is final: Meta does not document
  what a retried free-form send does, so each is best effort. The webhook only queues them on the
  `verification-automation` queue (`verification.acknowledgment`,
  `verification.unresolved_reply_nudge`, one attempt each);
  `CustomerReplyFollowUpService` (`src/modules/verification-replies/`) sends
  through `MessagingPort.sendFreeFormText`.
  - The acknowledgment follows a customer confirm or cancel (button or a
    recognized typed answer) that changed the row. Never after a merchant
    cancellation, an automatic `no_reply` or a test order.
  - The nudge follows a typed reply that quotes (`context.id`) an open
    verification's message, by `wa_message_id` or by the dispatch that sent
    it, and reads as no answer. The reply is stored in
    `verification_reply_events` without its text. Without `context.id` nothing
    is stored or sent. The verification still runs out to `no_reply` if the
    customer never taps a button.
  - One row per verification and kind in `verification_service_messages`,
    claimed before the send, so a replay or a crash never sends twice. Outside
    the 24-hour window, or when Meta answers 131047, the row is `skipped`
    (`outside_window`, `window_closed`); a missing text is `text_unavailable`.
    The text is the one for the language and dialect of the latest accepted
    send, else the language's `default` text.
  - A delivery receipt for a service message touches only its own row; a
    `failed` receipt marks it `failed` (`delivery_failed`).
- **Preview.** The settings response carries `template.messages` and
  `message` on each style, and the onboarding test carries `message`: lines of
  text and variable segments plus button labels. With
  `WHATSAPP_SNAPSHOT_PREVIEW_ENABLED` on they are read from the template text
  Meta returned at the last sync; otherwise from the stored preview. The
  response still carries the four-block `preview`/`previews` keys; the
  frontend reads only the neutral message.

## Merchant Controls

Controls are edited from the Settings page and persisted on the `integrations` table through `PATCH /api/onboarding/settings`.

| Control                  |            Default | Validation                                    | Business behavior                                                                                                     |
| ------------------------ | -----------------: | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `isAutoVerifyEnabled`    |             `true` | Boolean                                       | If disabled, new eligible COD orders are not stored or verified by `handleNewOrder`.                                  |
| `sendDelayMinutes`       |                `0` | `0..1440`                                     | Delays the initial WhatsApp send. Billing is not consumed until the delayed send executes.                            |
| `followUpEnabled`        |             `true` | Boolean                                       | Enables one follow-up message when the customer has not replied.                                                      |
| `followUpDelayMinutes`   |              `360` | `0..10080`                                    | Follow-up delay from the initial successful send time. Must be lower than escalation delay when follow-up is enabled. |
| `escalationDelayMinutes` |             `1800` | `0..10080`                                    | No-reply escalation delay from the initial successful send time. `0` disables escalation scheduling.                  |
| `autoCancelEnabled`      |            `false` | Boolean; needs `escalationEnabled`            | Cancel an order in its store when it reaches `no_reply` and every safety rule holds. Switching it off stops pending cancellations. |
| `autoCancelRestock`      |             `true` | Boolean                                       | Restock the items of an automatically canceled order (Shopify).                                                       |
| `autoCancelNotifyCustomer` |          `false` | Boolean                                       | Let Shopify tell the customer about an automatic cancellation.                                                        |
| `quietHoursEnabled`      |             `true` | Boolean                                       | When enabled, delayed automation jobs are moved outside quiet hours.                                                  |
| `quietHoursStart`        |            `22:00` | `HH:mm`, required when quiet hours enabled    | Start of quiet-hours window in the configured timezone.                                                               |
| `quietHoursEnd`          |            `09:00` | `HH:mm`, required when quiet hours enabled    | End of quiet-hours window in the configured timezone.                                                                 |
| `timezone`               |      `Asia/Riyadh` | Allowlist in `AUTOMATION_TIMEZONES`           | Timezone used for quiet-hours calculations.                                                                           |
| `defaultLanguage`        |             `auto` | `auto`, `en`, `ar`, `ur`, `es`, `fr`, `tr` | WhatsApp template language. `auto` follows the phone's country: Urdu, Spanish, French or Turkish where that language is live, else Arabic for Arabic-region prefixes and English otherwise. A language that is not live cannot be saved. |
| `codTemplateArVariant`   |         `standard` | Style of an active Arabic registry template   | Selected Arabic template style for send and preview. Seeded: `standard`, `egyptian`, `gulf`, `short`. Any other value answers `400 SETTINGS_TEMPLATE_STYLE_UNAVAILABLE`. |
| `codTemplateEnVariant`   |         `friendly` | Style of an active English registry template  | Selected English template style for send and preview. Seeded: `friendly`, `professional`, `direct`, `short`. Same rejection. |
| `shippingCurrency`       |              `USD` | Allowlist                                     | Used for dashboard savings display, not verification routing.                                                         |
| `avgShippingCost`        |                `3` | Number `>= 0`, max 2 decimals                 | Used for dashboard money-saved KPI.                                                                                   |

Cross-field rules:

- If follow-up is enabled, `followUpDelayMinutes < escalationDelayMinutes`.
- If quiet hours are enabled, both `quietHoursStart` and `quietHoursEnd` are required.
- Frontend validation mirrors backend validation before calling the API.

## Backend Code Map

| Area                          | File                                                                                        | Responsibility                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Shopify webhook controller    | `akeed-backend/src/infrastructure/spokes/shopify/shopify.controller.ts`                     | Receives `POST /webhooks/shopify/orders-create` and verifies Shopify HMAC through `ShopifyHmacGuard`.                                         |
| Shopify webhook ingestion     | `akeed-backend/src/infrastructure/spokes/shopify/services/shopify-order-webhook.service.ts` | Fast path that persists/enqueues the webhook and returns `200`.                                                                               |
| Webhook queue processor       | `akeed-backend/src/modules/webhook-queue/webhook-queue.processor.ts`                        | Loads integration, normalizes order, and calls core verification logic.                                                                       |
| Shopify order normalizer      | `akeed-backend/src/infrastructure/spokes/shopify/services/shopify-order.normalizer.ts`      | Extracts customer phone, order number, total, currency, and payment method from raw Shopify payload.                                          |
| COD eligibility               | `akeed-backend/src/modules/verification-core/order-eligibility.service.ts`                  | Dispatches platform-specific eligibility strategy.                                                                                            |
| Core orchestration            | `akeed-backend/src/modules/verification-core/verification-hub.service.ts`                   | Handles and validates new orders, idempotency, delayed initial sends, immediate sends, follow-up/no-reply scheduling, and final Shopify tags. |
| WhatsApp sending              | `akeed-backend/src/modules/verification-core/verification-send.service.ts`                  | Reserves billing usage, sends the WhatsApp template, marks initial status, and releases usage on send failure.                                |
| Automation producer           | `akeed-backend/src/modules/verification-automation/verification-automation.producer.ts`     | Enqueues deterministic BullMQ jobs for initial, follow-up, and no-reply automation.                                                           |
| Automation worker             | `akeed-backend/src/modules/verification-automation/verification-automation.processor.ts`    | Executes delayed initial sends, follow-ups, quiet-hours rescheduling, and no-reply escalation.                                                |
| WhatsApp adapter              | `akeed-backend/src/infrastructure/spokes/meta/whatsapp.service.ts`                          | Resolves language + selected template variant, then sends the mapped Meta template with confirm/cancel quick-reply payloads.                  |
| WhatsApp webhook              | `akeed-backend/src/infrastructure/spokes/meta/whatsapp.webhook.service.ts`                  | Handles customer button replies and delivery/read/failed status webhooks.                                                                     |
| Dashboard/verifications API   | `akeed-backend/src/modules/verifications/verifications.controller.ts`                       | Exposes stats, list, test send, and merchant no-reply cancellation endpoint.                                                                  |
| Merchant cancellation service | `akeed-backend/src/modules/verifications/verifications.service.ts`                          | Cancels no-reply Shopify orders and updates local verification state.                                                                         |
| Settings API                  | `akeed-backend/src/modules/onboarding/onboarding.controller.ts`                             | Exposes onboarding/settings state and updates.                                                                                                |
| Settings business rules       | `akeed-backend/src/modules/onboarding/onboarding-state.service.ts`                          | Persists merchant controls and enforces cross-field validation.                                                                               |

## Frontend Code Map

| Area                        | File                                                                                           | Responsibility                                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Dashboard hook              | `akeed-frontend/src/features/dashboard/domain/useDashboard.ts`                                 | Loads stats/list data, handles filters, test sends, and cancel-order UI state.                          |
| Dashboard standalone skin   | `akeed-frontend/src/features/dashboard/skins/standalone/DashboardStandaloneSkin.tsx`           | Standalone dashboard page composition.                                                                  |
| Dashboard embedded skin     | `akeed-frontend/src/features/dashboard/skins/embedded/DashboardEmbeddedSkin.tsx`               | Shopify embedded dashboard page composition.                                                            |
| Stats cards                 | `akeed-frontend/src/features/dashboard/skins/standalone/components/StandaloneStatsSummary.tsx` | Displays confirmed, canceled, awaiting response, reply rate, confirmation rate, usage, and savings.     |
| Verification table          | `akeed-frontend/src/features/dashboard/skins/standalone/VerificationsTableStandalone.tsx`      | Shows verification rows and no-reply cancel action in standalone mode.                                  |
| Embedded verification table | `akeed-frontend/src/features/dashboard/skins/embedded/VerificationsTableEmbedded.tsx`          | Shows verification rows and no-reply cancel action in embedded mode.                                    |
| Settings hook               | `akeed-frontend/src/features/settings/domain/useSettings.ts`                                   | Loads/saves merchant controls, template selections, validates values, and handles billing plan actions. |
| Settings standalone skin    | `akeed-frontend/src/features/settings/skins/standalone/SettingsStandaloneSkin.tsx`             | Standalone settings UI including branded template selectors and live preview.                           |
| Settings embedded skin      | `akeed-frontend/src/features/settings/skins/embedded/SettingsEmbeddedTabbedSkin.tsx`           | Polaris tabbed settings UI including branded template selectors and live preview.                       |
| Message preview route       | `akeed-frontend/src/app/[locale]/message-preview/page.tsx`                                     | Redirects to settings `message-preview` tab (single source of truth).                                   |
| API/auth wrapper            | `akeed-frontend/src/shared/lib/auth.ts`                                                        | Sends authenticated backend requests in standalone and embedded modes.                                  |

## API Reference

| Method  | Endpoint                          | Auth                 | Purpose                                              |
| ------- | --------------------------------- | -------------------- | ---------------------------------------------------- |
| `POST`  | `/webhooks/shopify/orders-create` | Shopify HMAC         | Ingest Shopify order creation webhook.               |
| `GET`   | `/webhooks/whatsapp`              | Verify token query   | Meta webhook verification challenge.                 |
| `POST`  | `/webhooks/whatsapp`              | Meta HMAC signature  | Receive WhatsApp replies and message status events.  |
| `GET`   | `/api/onboarding/state`           | `DualAuthGuard`      | Load current integration controls and billing state. |
| `PATCH` | `/api/onboarding/settings`        | `DualAuthGuard`      | Update merchant controls.                            |
| `GET`   | `/api/onboarding/billing/plans`   | `DualAuthGuard`      | Load Shopify billing plan options.                   |
| `POST`  | `/api/onboarding/billing`         | `DualAuthGuard`      | Start Shopify billing flow.                          |
| `GET`   | `/api/verifications`              | `DualAuthGuard`      | List verification rows for the dashboard (both runtime modes). |
| `GET`   | `/api/verifications/stats`        | `DualAuthGuard`      | Load dashboard KPIs.                                 |
| `POST`  | `/api/verifications/test`         | `DualAuthGuard`      | Send a test verification message.                    |
| `POST`  | `/api/verifications/:id/cancel`   | `DualAuthGuard`      | Merchant cancellation for `no_reply` verifications.  |
| `POST`  | `/api/verifications/:id/auto-cancel/exclude` | `DualAuthGuard` | Keep one order out of the automatic cancellation. |
| `POST`  | `/api/verifications/:id/auto-cancel/include` | `DualAuthGuard` | Let the automatic cancellation decide the order again. |
| `POST`  | `/api/orders`                     | `DualAuthGuard`      | Create a manual (Standalone) order for verification. |
| `POST`  | `/api/orders/:id/verification/retry` | `DualAuthGuard`   | Re-send a retryable failed verification.             |

`GET /api/orders` and `GET /api/orders/stats` were removed. Both runtime modes
read `/api/verifications` and `/api/verifications/stats`, so there is one status
vocabulary — the nine `verification_status` values — rather than the wider
14-value order projection the standalone dashboard used to render. The extra
states (`accepted`, `processing`, `ineligible`, `blocked`, `review_required`)
survive only inside `OrdersRepository.findDashboardOrderById`, where retry
safety needs them; they are never returned to a client.

## Data Model Reference

Primary tables:

| Table            | Important fields                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `integrations`   | `platformType`, `platformStoreUrl`, `accessToken`, `isActive` (installation state), `storeName`, `defaultLanguage`, `codTemplateArKey`, `codTemplateEnKey`, `codTemplateUrKey`, `codTemplateEsKey`, `codTemplateFrKey` (with the old `codTemplateArVariant`, `codTemplateEnVariant` kept in step), `shippingCurrency`, `avgShippingCost`, `isAutoVerifyEnabled`, `billingPlanId`, `billingStatus` (entitlement state), `followUpEnabled`, `followUpDelayMinutes`, `escalationEnabled`, `escalationDelayMinutes`, `quietHoursEnabled`, `quietHoursStart`, `quietHoursEnd`, `timezone`, `sendDelayMinutes` |
| `orders`         | `orgId`, `integrationId`, `externalOrderId`, `orderNumber`, `customerPhone`, `customerName`, `totalPrice`, `currency`, `paymentMethod`, `rawPayload`; source identity/deduplication is `(orgId, integrationId, externalOrderId)` and the database verifies integration ownership                                                                                                                                                                                               |
| `verifications`  | `orgId`, `orderId`, `status`, `waMessageId`, `templateName`, `languageCode`, `attempts`, `lastSentAt`, `confirmedAt`, `canceledAt`, `deliveredAt`, `readAt`, `followUpSentAt`, `noReplyAt`, `followUpAttempts`, `merchantCanceledAt`, `cancellationSource`, `metadata`                                                                                                                                                                                                    |
| `usage_alerts`   | `orgId`, `integrationId`, `kind` (`plan_usage`, `credit_balance`), `level`, `cycleKey`, `emailStatus`, `emailError`, `sentAt`, `resolvedAt`; one row per alert, deduplicated by a unique index per billing period (plans) or per open incident (credits) |
| `webhook_events` | `platform`, `jobType`, `idempotencyKey`, `storeDomain`, `orgId`, `integrationId`, `status`, `rawPayload`, `attempts`, `lastError`, `processedAt`                                                                                                                                                                                                                                                                                                                          |

Important constraints and indexes:

- `unique_active_verification_per_order` prevents duplicate verification rows per order.
- `idx_verifications_org_created_id` supports dashboard pagination.
- `idx_verifications_org_created_status` supports dashboard status/date filtering.
- `idx_verifications_wa_id` supports Meta status webhook lookup by `waMessageId`.
- `idx_verifications_status_org_created` supports the blocked-order count, the recovery sweep and its oldest-first scan.
- `webhook_events` has unique idempotency per platform webhook id.

## Billing And Usage Rules

Plan limits are defined in `akeed-backend/src/modules/onboarding/onboarding.service.helpers.ts`.

| Plan               | Monthly price | Included WhatsApp confirmations | Public positioning                     |
| ------------------ | ------------: | ------------------------------: | -------------------------------------- |
| Starter            |           `0` |                   `30` one-time | Try Akeed before paying                |
| Basic              |        `9.99` |                   `300` monthly | Start confirming COD orders            |
| Pro                |       `22.99` |                  `1000` monthly | For stores confirming COD orders daily |
| Scale (`business`) |       `49.99` |                  `2500` monthly | Higher-volume COD stores               |

Usage principles:

- Usage is reserved when a WhatsApp send is attempted, not when a verification row is created.
- Delayed initial sends consume only when the delayed worker sends the message.
- Failed initial and follow-up sends release the usage reservation exactly once.
- Unknown provider outcomes are refunded while failed and restored to their original billing period if staff later proves acceptance.
- Follow-up messages consume included monthly confirmations.
- Follow-up failure does not fail the overall verification.
- Acknowledgments and nudges are free at Meta: they reserve no usage, write no credit or dispatch row, and are
  recorded only in `verification_service_messages`.
- Dashboard usage shows consumed count and included limit for the current billing period.
- Plans have no usage-based Shopify billing line item; when the included limit is reached, sending stops until renewal or upgrade. New orders wait at `blocked` and are sent automatically when capacity returns (see [Orders blocked by capacity](#orders-blocked-by-capacity)).

## Reliability And Safety

Idempotency:

- Shopify webhook id is persisted through `webhook_events`.
- Order creation is deduped by external order id and organization.
- Verification creation is constrained to one row per order.
- Automation jobs use deterministic job ids.
- Merchant cancellation is idempotent for already merchant-canceled rows.

Security:

- Shopify webhooks are protected by `ShopifyHmacGuard`.
- Authenticated app APIs use `DualAuthGuard` for embedded Shopify and standalone modes.
- Shopify access tokens are decrypted only inside the Shopify adapter.
- Logs must not include secrets or access tokens.

Operational behavior:

- Shopify order webhooks return quickly and defer business processing to BullMQ.
- BullMQ retries webhook and automation jobs with exponential backoff.
- Quiet hours are checked both when scheduling and when the worker executes.
- If BullMQ cannot move a job to delayed due to a missing token, the worker logs and processes immediately for quiet-hours cases.

## Known Business Decisions

- Only COD orders are verified.
- Disabling auto verification skips new verification creation entirely.
- Customer cancel does not automatically cancel the Shopify order; it marks and tags the order for merchant awareness.
- Merchant order cancellation is available only after `no_reply` escalation.
- Automatic cancellation is opt-in per store and runs only at `no_reply`, only for orders whose every message was delivered and whose customer never wrote; anything Akeed cannot prove pauses it.
- Shopify cancellation is called before local state is changed.
- Branded template defaults are `friendly` for English and `standard` for Arabic.
- Legacy short template variants stay available and keep their existing two-body-parameter shape.
- `no_reply` is excluded from customer reply rate numerator unless the customer later replies before merchant cancellation.
- Tagging failures after irreversible actions are logged but do not fail the completed action.

## Validation Commands

Backend:

```bash
npm --prefix akeed-backend run lint
npm --prefix akeed-backend run test
npm --prefix akeed-backend run build
```

Frontend:

```bash
npm --prefix akeed-frontend run lint
npm --prefix akeed-frontend exec tsc --noEmit
npm --prefix akeed-frontend run build
```

Note: frontend production build can fail in restricted environments if Google Fonts cannot be fetched. In that case, lint and typecheck are still useful code validation signals.

## Recommended Test Scenarios

Manual end-to-end scenarios:

| Scenario                                                      | Expected result                                                                                                                          |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Non-COD Shopify order                                         | Webhook is accepted, order is skipped, no verification is created.                                                                       |
| COD order with auto verify disabled                           | Webhook is accepted, verification is skipped with reason `auto_verify_disabled`.                                                         |
| COD order with immediate send                                 | Verification becomes `sent`, WhatsApp message is delivered to customer, follow-up/no-reply jobs are scheduled.                           |
| Customer confirms                                             | Verification becomes `confirmed`, Shopify order is tagged `Akeed: Verified`.                                                             |
| Customer cancels                                              | Verification becomes `canceled`, `cancellationSource = customer`, Shopify order is tagged `Akeed: Canceled`.                             |
| Follow-up enabled and no reply                                | One follow-up is sent, `followUpAttempts` increments.                                                                                    |
| No reply after escalation delay                               | Verification becomes `no_reply`, Shopify order is tagged `Akeed: No Reply`.                                                              |
| Merchant cancels no-reply order                               | Shopify order is canceled, verification becomes `canceled`, `cancellationSource = merchant_no_reply`, order is tagged `Akeed: Canceled`. |
| Late delivery/read after no-reply                             | Status stays `no_reply`.                                                                                                                 |
| Late customer reply after no-reply but before merchant cancel | Status can become `confirmed` or customer `canceled`.                                                                                    |
| Late customer reply after merchant cancel                     | Reply is ignored.                                                                                                                        |
