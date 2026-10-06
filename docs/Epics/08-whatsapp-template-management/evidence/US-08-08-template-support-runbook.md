# US-08-08 — WhatsApp template support runbook

- **Story:** [US-08-08 — Release gate](../US-08-08-release-gate.md)
- **Written:** 2026-10-06
- **For:** support and staff operators. No step here needs a developer or a deploy, except where it says so.
- **Meta behavior:** every statement about Meta comes from the [US-08-01 contract record](US-08-01-contract-record.md). The number in brackets is the record finding.

Each environment (dev, prod) has its own Meta app, its own templates and its own switches. Do every step in the environment that has the problem.

## 1. Quick reference

| I need to | Do this | Section |
| --- | --- | --- |
| Stop staff changing templates, without touching sends | Set `WHATSAPP_TEMPLATE_OPERATIONS_ENABLED=false` and restart. Do **not** empty the operator list: that opens writes to all staff | [5](#5-pause-template-writes-without-touching-sends) |
| Send exactly as before E08 | Turn off the guardrail and the US-08-07 switches | [4](#4-fall-back-to-the-seeded-defaults) |
| Stop reading Meta | Set `WHATSAPP_TEMPLATE_SYNC_ENABLED=false` and restart | [6](#6-stop-the-sync) |
| Replace a template Meta paused or rejected | Activate an approved one, then retire the old one with it as the replacement | [3](#3-choose-and-activate-a-replacement) |
| Find out why a customer got a different style | Read the dispatch's fallback reason | [7](#7-logs-alert-codes-and-queries) |

Switches are environment variables ([ENVIRONMENT.md](../../../ENVIRONMENT.md#whatsapp-templates-e08)). A change takes effect when the service restarts. Turning a switch off deletes nothing.

## 2. A template is paused, rejected, disabled or re-categorized

### How you find out

- **Admin › Templates** (`/admin/templates`) shows the status Meta last reported and "Cannot be sent" next to a template that is active in Akeed but not approved at Meta.
- **Admin › Stores** raises the `template_unavailable` health signal on each store that can send nothing in a language it sends in.
- The log has a `whatsapp-template-alert` line (section 7).
- Meta also emails the account admins and shows a notification in WhatsApp Manager (4.2.4).

A webhook is only a hint. Press **Sync now** (operators only) to read the real status from Meta; a sync is the truth (worst-case rule under 4.8).

### What each status means

| Meta says | Can it be sent? | Does it recover by itself? | What to do |
| --- | --- | --- | --- |
| Paused | No (4.2.5) | Yes. The first pause lasts 3 hours and the second 6 hours (4.2.7). | Wait, then Sync now. If stores depend on it, use a replacement meanwhile (section 3). A third pause disables it. |
| Disabled | No (4.2.5) | No | Replace it (section 3). |
| Rejected | No | No | Read the rejection reason on the template page. Write a new template, or edit this one only if no store can send it (4.3.9 rule). |
| Flagged, Locked, Limit exceeded, In appeal, Reinstated, Unarchived | No, until a sync reads `Approved` (4.2.11 rule) | Unknown | Sync now. If it stays, treat it as Disabled. |
| Archived | No (4.2.5) | No. Meta deletes it 28 days later (4.2.9). | If it is still needed, unarchive it in WhatsApp Manager within the 28 days, then Sync now. |
| Missing at Meta | No | No | Compare with "At Meta, not in Akeed" on the sync result. Replace it (section 3). |
| Re-categorized (utility to marketing) | **Yes.** Meta keeps it approved (4.5.5). | No | It now costs more and some messages will not be delivered (4.5.9, 4.5.12). Decide with the product owner whether to replace it. Meta gives 60 days to appeal through Business Support (4.5.8). |

### What the customer sees (guardrail on)

| Case | The customer receives |
| --- | --- |
| The store's chosen template cannot be sent, and the language default can | The language default, in the same language. Nothing tells the customer it is a different style. |
| The chosen template and the language default both cannot be sent | **Nothing.** Akeed never sends the other language and never picks a third template. |
| The reminder's template cannot be sent | The same two rules, decided again when the reminder is due. |
| Re-categorized | The same message as before. |

With the guardrail **off**, Akeed sends the chosen template whatever Meta says. Meta then refuses it (132001, 132015 or 132016 in 4.2.6), and the send is recorded as a provider rejection.

### What the store sees

| Case | In the merchant dashboard |
| --- | --- |
| Fallback to the default | The verification looks normal. The style used is not shown to the merchant; staff see it on the template pages and in the dispatch record. |
| Skipped first send | The verification is **Failed**, and the merchant reads: "The WhatsApp message for this order is unavailable right now, so nothing was sent and no credit was used. Akeed support has been alerted. Retry later." No usage or credit was taken. It can be retried once a template is back. |
| Skipped reminder | The verification stays as it was after the first send. The reminder is recorded as skipped (`follow_up_skipped: template_unavailable`), with no usage. |

## 3. Choose and activate a replacement

Operators only. Each action is audited.

1. Open **Admin › Templates**. Pick a template of the **same purpose and language** that is **Approved** at Meta. Open it and check its text and its "Matches Meta" check.
2. If it is not active, press **Activate**. Only an approved template can be activated.
3. Optional: send it to a staff phone with **Send test** (the phone must be on `WHATSAPP_TEMPLATE_TEST_PHONES`).
4. If the broken template is the language default, press **Make default** on the replacement.
5. On the broken template, press **Retire** (or **Deactivate**, if you expect it back) and choose the replacement. Every store that had chosen the broken template moves to the replacement in the same step.

If no approved template exists in that language, there is nothing to activate. Either wait for the pause to end, or write a new template (**New draft**, **Submit to Meta**) and wait for Meta's review, which can take 24 hours (4.2.3). Until then sends in that language are skipped while the guardrail is on. If skipped sends are worse than refused sends for you, turn the guardrail off (section 4): this only helps when Meta would in fact accept the template.

A retired template never comes back. Use **Deactivate** when you are not sure.

## 4. Fall back to the seeded defaults

"Seeded defaults" means the state migration `0054` created: the 8 original templates, all active, with `ar` / `standard` and `en` / `friendly` as the defaults. That state is always a valid one, so going back never needs a code revert.

### Step 1: turn the new behavior off (no data change)

Set these to `false` (or remove them) and restart:

```
WHATSAPP_TEMPLATE_GUARDRAIL_ENABLED=false
WHATSAPP_REMINDER_TEMPLATE_ENABLED=false
WHATSAPP_ACKNOWLEDGMENT_ENABLED=false
WHATSAPP_UNRESOLVED_REPLY_NUDGE_ENABLED=false
WHATSAPP_ARABIC_STYLE_AUTO_ENABLED=false
WHATSAPP_LOCALIZED_FALLBACKS_ENABLED=false
WHATSAPP_AMOUNT_FORMATTING_ENABLED=false
WHATSAPP_SNAPSHOT_PREVIEW_ENABLED=false
```

Now every send uses the store's stored choice if it is active in Akeed, with the payload the characterization suite pins. Stored reminder choices, `auto` choices and free-form texts stay in the database and are ignored.

This is enough in almost every case.

### Step 2: check whether the registry itself still is the seeded one

Read-only. Run it in the environment's SQL editor:

```sql
select "key", is_active, is_default, retired_at is not null as retired
from whatsapp_templates
where purpose = 'cod_confirmation'
order by language, "key";

select coalesce(cod_template_ar_key, '(none)') as ar_key,
       coalesce(cod_template_en_key, '(none)') as en_key,
       count(*) as stores
from integrations
where coalesce(is_active, false)
group by 1, 2
order by 3 desc;
```

The registry is "seeded" when the 8 original keys are active, not retired, and the defaults are `cod_confirm.ar.standard` and `cod_confirm.en.friendly`. Stores may point at a staff-written template (`..._v1`); that is fine as long as it is active.

### Step 3: reset the defaults, only if step 2 shows they moved

Prefer the admin page: **Make default** on `cod_confirm.ar.standard` and on `cod_confirm.en.friendly`. It needs them approved at Meta.

If the page cannot do it (Meta does not report them approved, or template operations are off), a developer or the product owner runs this, once, in one transaction. It changes the two default flags and reactivates the original 8. It does not touch any store's choice.

```sql
begin;
update whatsapp_templates set is_default = false
 where purpose = 'cod_confirmation' and is_default
   and "key" not in ('cod_confirm.ar.standard', 'cod_confirm.en.friendly');
update whatsapp_templates set is_active = true
 where "key" in (
   'cod_confirm.ar.standard', 'cod_confirm.ar.egyptian', 'cod_confirm.ar.gulf', 'cod_confirm.ar.short',
   'cod_confirm.en.friendly', 'cod_confirm.en.professional', 'cod_confirm.en.direct', 'cod_confirm.en.short')
   and retired_at is null;
update whatsapp_templates set is_default = true
 where "key" in ('cod_confirm.ar.standard', 'cod_confirm.en.friendly');
commit;
```

The second statement skips a retired template on purpose: un-retiring one is a decision, not a reset. If step 2 shows an original template retired, stop and ask the product owner. The registry is cached for 60 seconds per process, so the change is live within a minute.

## 5. Pause template writes without touching sends

Set `WHATSAPP_TEMPLATE_OPERATIONS_ENABLED=false` and restart.

- Every template write answers `403 WHATSAPP_TEMPLATE_OPERATIONS_DISABLED`, for every staff member, operators included: drafts, submit, "Check at Meta", edit, activate, deactivate, set default, retire, Sync now, staff test sends and free-form text changes.
- **Sends do not change.** Templates that are active (and, with the guardrail on, approved) keep sending. The scheduled sync and the template webhooks keep running.
- Staff can still read every template page.

**Who may write.** `WHATSAPP_TEMPLATE_OPERATOR_IDS` is the list of staff user IDs allowed to write. While it names at least one ID, staff who are not on it get `403 WHATSAPP_TEMPLATE_OPERATOR_REQUIRED`.

> **An empty list means every staff member may write** while operations are on (rule changed on 2026-10-06, commit `2fd3cc6`). So taking the *last* ID off the list does not lock anyone out: it lets everyone in. To remove one person, leave at least one other ID on the list. To stop everyone, use the switch above.

In prod, keep the list filled in. Every write is audited with the user who made it either way.

## 6. Stop the sync

Set `WHATSAPP_TEMPLATE_SYNC_ENABLED=false` and restart.

- The 6-hourly schedule is removed, Sync now is refused, and template webhooks are acknowledged and ignored.
- The last snapshot stays. **With the guardrail still on, sends keep following that last snapshot**, which now goes stale: a template Meta pauses after this point is still sent (and refused by Meta), and one Meta re-approves stays blocked. If you stop the sync for more than a few hours, turn the guardrail off as well.

A sync that fails changes nothing and is not retried; the next scheduled run is the retry. A run left `running` for 15 minutes is closed as abandoned by the next one.

## 7. Logs, alert codes and queries

### Log lines (search by `action`)

| `action` | What it tells you |
| --- | --- |
| `whatsapp-template-alert` | A template in use changed. `alertCode` is `template_unavailable` or `template_recategorized` (critical), `template_text_changed` or `template_sync_failed` (attention). Carries the template key, never its text. |
| `whatsapp-template-sync` | One sync run: counts, or a neutral `errorCode` (`auth_failed`, `permission_denied`, `rate_limited`, `network`, `provider_error`, `not_configured`, `too_many_pages`, `persistence_failed`). |
| `whatsapp-template-events` / `whatsapp-template-event` | Template webhooks: how many were applied, stale, conflicting, unregistered or duplicates. |
| `meta-template-webhook` | A template webhook that was dropped, for example `wrong_account`. |
| `meta-template-list`, `meta-template-create`, `meta-template-edit` | A failed call to Meta, with Meta's numeric code. |
| `sendOnce.templateFallback` | A send used the language default. `reason` and `storedTemplateKey` say why and which choice was passed over. |
| `sendOnce.templateSelection` with `reason: template_unavailable` | A send was skipped: no template could be sent in that language. |
| `whatsapp-template-operator-check` | A template write was refused, with `errorCode`. |
| `whatsapp-text-send`, `customer-reply-follow-up` | An acknowledgment or a nudge (US-08-07 b, c): sent, skipped (`window_closed`, `outside_window`, `text_unavailable`) or failed. |

`permission_denied` and `auth_failed` are a token problem, not a template problem: the token needs `whatsapp_business_management` (4.1.8).

### Fallback and skip reasons on a send

`verification_message_dispatches.template_fallback_reason`, with the passed-over key in `template_skipped_key`:

| Reason | Meaning |
| --- | --- |
| `not_approved` | Guardrail on: Meta has not approved the chosen template. |
| `key_inactive` | The chosen template is switched off or retired in Akeed. |
| `key_unknown` | The store's stored key is not in the registry. |
| `wrong_language` | The stored key belongs to another language or purpose. |
| `reminder_unavailable` | The chosen reminder could not be sent, so the reminder carried the first-send template. |
| `auto_style_unavailable` | The style `auto` picked could not be sent, so the Arabic default was. |

A skipped send has no dispatch row. Its reason is `template_unavailable`, on the verification (first send) or as `follow_up_skipped` (reminder).

### Read-only queries

Fallbacks and what they replaced, last 7 days:

```sql
select template_fallback_reason, template_skipped_key, template_variant_key, count(*) as sends
from verification_message_dispatches
where created_at >= now() - interval '7 days' and template_fallback_reason is not null
group by 1, 2, 3 order by 4 desc;
```

Templates that are active in Akeed and not approved at Meta:

```sql
select "key", review_status, category, pending_category, quality, last_synced_at
from whatsapp_templates
where is_active and review_status is distinct from 'approved'
order by "key";
```

The last sync runs:

```sql
select started_at, finished_at, trigger, status, error_code, updated_count, missing_keys, unknown_at_provider
from whatsapp_template_sync_runs order by started_at desc limit 10;
```

Who changed what (template text is never in an audit row):

```sql
select created_at, user_id, action, outcome, metadata
from admin_access_audit
where action like 'whatsapp-template%' or action like 'whatsapp-message-text%'
order by created_at desc limit 50;
```

## 8. Never do this

- **Never edit a live template in WhatsApp Manager.** Akeed's variables, button order and preview no longer match, the template goes back to review and cannot be sent meanwhile (4.3.8), and a failed review may leave it rejected with the old text gone (4.3.9). New text is always a new template, activated once approved.
- **Never delete a template in WhatsApp Manager.** Deleting by name removes every language of that name (4.4.3), and the name cannot be reused for 30 days (4.4.4). Retire it in Akeed instead.
- **Never swap the confirm and cancel buttons** in WhatsApp Manager. Akeed puts the confirm payload on the first button (4.7.6); a swapped template records a confirmation as a cancellation.
- **Never change a template's variables or parameter format** in WhatsApp Manager (4.4.7 rule).
- **Never copy a template ID, status or category from dev to prod.** Each environment reads its own from its own sync.
- **Never turn the guardrail on before the environment's first successful sync has been read and compared.** A registry template that is `missing` at Meta stops being sent the moment the guardrail is on.
- **Never run a write statement on `whatsapp_templates` or `integrations` other than the reset in section 4**, and that one only on the product owner's word.
- **Never paste an access token or app secret** into a ticket, a chat or a log. Support never needs one.
- **Never retry a submit or an edit that answered "unresolved"** by pressing it again elsewhere. Use **Check at Meta**: the first request may have been applied (rule under 4.1).
