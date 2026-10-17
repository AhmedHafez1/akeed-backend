# WhatsApp template support runbook

For support and staff operators. No step here needs a developer or a deploy, except where it says so. How template sync, the guardrail and authoring work is in [Integrations, Webhooks, And Automation](INTEGRATIONS_WEBHOOKS_AND_AUTOMATION.md#template-sync-status-webhooks-and-the-send-guardrail).

Each environment (dev, prod) has its own Meta app, its own templates and its own switches. Do every step in the environment that has the problem.

## 1. Quick reference

| I need to | Do this | Section |
| --- | --- | --- |
| Stop staff changing templates, without touching sends | Set `WHATSAPP_TEMPLATE_OPERATIONS_ENABLED=false` and restart. Do **not** empty the operator list: that opens writes to all staff | [5](#5-pause-template-writes-without-touching-sends) |
| Send only the stored choice, with none of the optional behavior | Turn off the guardrail and the message-improvement switches | [4](#4-fall-back-to-the-seeded-defaults) |
| Stop reading Meta | Set `WHATSAPP_TEMPLATE_SYNC_ENABLED=false` and restart | [6](#6-stop-the-sync) |
| Replace a template Meta paused or rejected | Activate an approved one, then retire the old one with it as the replacement | [3](#3-choose-and-activate-a-replacement) |
| Find out why a customer got a different style | Read the dispatch's fallback reason | [7](#7-logs-alert-codes-and-queries) |
| Send a store's logo on its messages | **Create missing twins**, then activate the approved ones and switch the store's logo header on | [10](#10-image-header-twins-for-the-logo-header) |

Switches are environment variables ([ENVIRONMENT.md](ENVIRONMENT.md#whatsapp-templates)). A change takes effect when the service restarts. Turning a switch off deletes nothing.

## 2. A template is paused, rejected, disabled or re-categorized

### How you find out

- **Admin › Templates** (`/admin/templates`) shows the status Meta last reported and "Cannot be sent" next to a template that is active in Akeed but not approved at Meta.
- **Admin › Stores** raises the `template_unavailable` health signal on each store that can send nothing in a language it sends in.
- The log has a `whatsapp-template-alert` line (section 7).
- Meta also emails the account admins and shows a notification in WhatsApp Manager.

A webhook is only a hint. Press **Sync now** (operators only) to read the real status from Meta; a sync is the truth.

### What each status means

| Meta says | Can it be sent? | Does it recover by itself? | What to do |
| --- | --- | --- | --- |
| Paused | No | Yes. The first pause lasts 3 hours and the second 6 hours. | Wait, then Sync now. If stores depend on it, use a replacement meanwhile (section 3). A third pause disables it. |
| Disabled | No | No | Replace it (section 3). |
| Rejected | No | No | Read the rejection reason on the template page. Write a new template, or edit this one only if no store can send it. |
| Flagged, Locked, Limit exceeded, In appeal, Reinstated, Unarchived | No, until a sync reads `Approved` | Unknown | Sync now. If it stays, treat it as Disabled. |
| Archived | No | No. Meta deletes it 28 days later. | If it is still needed, unarchive it in WhatsApp Manager within the 28 days, then Sync now. |
| Missing at Meta | No | No | Compare with "At Meta, not in Akeed" on the sync result. Replace it (section 3). |
| Re-categorized (utility to marketing) | **Yes.** Meta keeps it approved. | No | It now costs more and some messages will not be delivered. Decide with the product owner whether to replace it. Meta gives 60 days to appeal through Business Support. |

### What the customer sees (guardrail on)

| Case | The customer receives |
| --- | --- |
| The store's chosen template cannot be sent, and the language default can | The language default, in the same language. Nothing tells the customer it is a different style. |
| The chosen template and the language default both cannot be sent | **Nothing.** Akeed never sends the other language and never picks a third template. |
| The reminder's template cannot be sent | The same two rules, decided again when the reminder is due. |
| Re-categorized | The same message as before. |

With the guardrail **off**, Akeed sends the chosen template whatever Meta says. Meta then refuses it (error 132001, 132015 or 132016), and the send is recorded as a provider rejection.

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

If no approved template exists in that language, there is nothing to activate. Either wait for the pause to end, or write a new template (**New draft**, **Submit to Meta**) and wait for Meta's review, which can take 24 hours. Until then sends in that language are skipped while the guardrail is on. If skipped sends are worse than refused sends for you, turn the guardrail off (section 4): this only helps when Meta would in fact accept the template.

A retired template never comes back. Use **Deactivate** when you are not sure.

## 4. Fall back to the seeded defaults

"Seeded defaults" means the state migration `0054` created: the 8 original templates, all active, with `ar` / `standard` and `en` / `friendly` as the defaults. That state is always a valid one, so going back never needs a code revert.

### Step 1: turn the optional behavior off (no data change)

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

Now every send uses the store's stored choice if it is active in Akeed. Stored reminder choices, `auto` choices and free-form texts stay in the database and are ignored.

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

If the page cannot do it (Meta does not report them approved, or template operations are off), a developer or the product owner runs this, once, in one transaction. It changes the two default flags and reactivates the original 8. It does not touch any store's choice, and it leaves Urdu, Spanish, French and Turkish alone: they were never seeded, so they have no state to go back to (section 9).

```sql
begin;
update whatsapp_templates set is_default = false
 where purpose = 'cod_confirmation' and is_default
   and language in ('ar', 'en')
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

> **An empty list means every staff member may write** while operations are on. So taking the *last* ID off the list does not lock anyone out: it lets everyone in. To remove one person, leave at least one other ID on the list. To stop everyone, use the switch above.

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
| `whatsapp-text-send`, `customer-reply-follow-up` | An acknowledgment or a nudge: sent, skipped (`window_closed`, `outside_window`, `text_unavailable`) or failed. |
| `whatsapp-template-image-twin` | One template in a **Create missing twins** run: `twinOutcome` (`created`, `adopted`, `failed`, `unresolved`, `not_attempted`), with `reason` and Meta's `providerCode` when refused. The run's counts are on the audit row `whatsapp-templates.image-twins.create`. |
| `meta-template-image-upload` | The sample image upload for a run, with Meta's code when refused. |
| `whatsapp-template-send-image-fallback` | Meta refused an image-header send with a media or template code (`providerErrorCode`), and the text template was sent once instead. Repeated lines for one twin mean the twin needs attention (section 10). |

`permission_denied` and `auth_failed` are a token problem, not a template problem: the token needs `whatsapp_business_management`.

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
| `order_details_missing` | The chosen template shows the order's items, region or address and this order has none (its source does not deliver them, or it was stored before migration `0063`), so the language default was sent. Expected for every source except EasyOrders and Shopify. |

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

- **Never edit a live template in WhatsApp Manager.** Akeed's variables, button order and preview no longer match, the template goes back to review and cannot be sent meanwhile, and a failed review may leave it rejected with the old text gone. New text is always a new template, activated once approved.
- **Never delete a template in WhatsApp Manager.** Deleting by name removes every language of that name, and the name cannot be reused for 30 days. Retire it in Akeed instead.
- **Never swap the confirm and cancel buttons** in WhatsApp Manager. Akeed puts the confirm payload on the first button; a swapped template records a confirmation as a cancellation.
- **Never change a template's variables or parameter format** in WhatsApp Manager.
- **Never copy a template ID, status or category from dev to prod.** Each environment reads its own from its own sync.
- **Never turn the guardrail on before the environment's first successful sync has been read and compared.** A registry template that is `missing` at Meta stops being sent the moment the guardrail is on.
- **Never run a write statement on `whatsapp_templates` or `integrations` other than the reset in section 4 and the twin registration in section 10**, and those only on the product owner's word.
- **Never activate a template to "unlock" a language for a merchant.** A language opens only through section 9, after Meta's approval.
- **Never paste an access token or app secret** into a ticket, a chat or a log. Support never needs one.
- **Never retry a submit or an edit that answered "unresolved"** by pressing it again elsewhere. Use **Check at Meta**: the first request may have been applied.

## 9. Launch Urdu, Spanish, French or Turkish

Akeed has six message languages: Arabic, English, Urdu, Spanish, French and Turkish. Arabic and English were seeded and are always on. Urdu, Spanish, French and Turkish start with **no approved template**, so each one is switched on here. A language is **live** once it has an active default template; only then can a store be set to it, and only then does `auto` send it (Pakistan gets Urdu, Spain and Spanish-speaking Latin America get Spanish, France gets French, Türkiye gets Turkish).

Before a language is live:

- Merchants see it in **Settings › Message**, marked "Awaiting WhatsApp approval", and cannot choose it. Saving it anyway is refused with `SETTINGS_LANGUAGE_UNAVAILABLE`.
- Templates you have submitted appear to merchants as locked cards. A draft you have not submitted is never shown to merchants.
- Customers in those countries keep getting English under `auto`, exactly as before.

Migration `0064` created three drafts per language for Urdu, Spanish and French, and migration `0068` the same three for Turkish: a `standard` and a `short` confirmation, and a `standard` reminder. It also wrote the five free-form texts of each language (the two acknowledgments, the "press a button" nudge and the two name fallbacks), already active. A free-form text is not a Meta template and needs no approval; it is only read for a customer whose message went out in that language.

Operators only, one language at a time:

1. Open **Admin › Templates**, section **Drafts**. Open the language's three drafts and read the body and both buttons. If you change the wording, **Save draft** until the check shows no error.
2. Press **Submit to Meta** on each. The template now exists at Meta in review, and in Akeed as an inactive template.
3. Wait for Meta's review (up to 24 hours), then press **Sync now**. Do not continue until the template shows **Approved**. A rejected template is edited or replaced by a new draft; it cannot be activated.
4. Press **Activate** on each approved template. Activation is refused for anything not approved.
5. Optional: **Send test** to a staff phone on `WHATSAPP_TEMPLATE_TEST_PHONES`.
6. Press **Make default** on the confirmation new stores should get (normally `standard`). The language is live from this moment, within a minute (registry cache). The reminder needs no default: once it is active, a store can choose it in **Settings › Message** while `WHATSAPP_REMINDER_TEMPLATE_ENABLED` is on, and a store that chooses nothing repeats its first message.
7. Read the free-form texts of the language in **Admin › Message texts** and change any wording you want. If one is switched off or deleted, that follow-up is skipped as `text_unavailable` for the language.

To take a language back out: make sure no store is set to it, then **Deactivate** its default. With the guardrail on, a language whose default Meta paused also stops being chosen by `auto`; those customers get English again, and a store forced to that language has its sends skipped (section 2).

Read-only check of what is live and who uses it:

```sql
select language, "key", is_active, is_default, review_status
from whatsapp_templates
where purpose = 'cod_confirmation' and language in ('ur', 'es', 'fr', 'tr')
order by language, "key";

select default_language, count(*) as stores
from integrations
where coalesce(is_active, false)
group by 1
order by 2 desc;
```

## 10. Image-header twins for the logo header

A store with the logo header on sends its banner as an image header, through the **twin** of the template it already sends: the same body, the same two buttons in the same order and the same variables, plus an IMAGE header. Selection does not change: the store's style, its reminder and Arabic `auto` pick the template as before, and only at send time is the twin sent in its place. A template without an active twin (approved, while the guardrail is on) is sent as text. Twins never appear in store settings or in the **Admin › Templates** list; the **Image twins** panel on that page shows them.

If Meta refuses the image send with a media or template error (`131052`, `131053`, `132000`, `132001`, `132012`, `132015`, `132016`), the text template is sent once instead and `whatsapp-template-send-image-fallback` is logged. Any other failure is handled as for a text send; nothing is sent twice. If Meta accepts the image and reports a media failure later, in the status webhook, the message is not resent.

### Create the twins of every template (operators)

Needs `META_APP_ID` ([ENVIRONMENT.md](ENVIRONMENT.md#whatsapp-templates)) and a synced registry.

1. In **Admin › Templates**, the **Image twins** panel counts the templates, their twins, and how many are approved, active and missing.
2. Press **Create missing twins** and confirm. Akeed uploads one neutral sample banner, then submits, one at a time, a twin named `<template name>_logo` for every template that has none: the same language, category, body, footer and quick replies, plus an IMAGE header. Each twin is registered inactive at once. The result lists every template:
   - **Submitted**: created at Meta, waiting for review.
   - **Found at Meta**: Meta already had `<name>_logo` (an earlier run, or an answer Akeed could not read); registered without sending it again.
   - **Skipped**: `has_twin`, `retired`, `not_synced` (sync first), `unreadable`, `text_header` (a template with a text header cannot take an image), `non_quick_reply_button`, `format_mismatch` or `unknown_category`.
   - **Refused**: Meta's reason and code. Fix the cause, then run again.
   - **Unknown**: no usable answer. Run again: Akeed checks Meta's list first, so nothing is sent twice.
   - **Not tried**: the run stopped at a rate limit or a token problem. Run again later.
3. Wait for Meta's review (up to 24 hours), press **Sync now**, then **Activate approved twins**. Only twins Meta approved are switched on; the rest are listed as waiting.
4. Switch the logo header on per store (step 6 below).

A second run only fills the gaps. Running it costs nothing when every template already has a twin.

### One twin by hand (fallback)

Operators only, one template at a time:

1. Find the store's template: its first-send and reminder keys are on the store, or the language default when the key is empty.
2. In WhatsApp Manager, create a new template with a new name (for example the parent's name plus `_logo`), the same language and category, an **Image** header with any sample banner, and the parent's body and buttons copied exactly. Wait for **Approved**.
3. Register it as the parent's twin, inactive, copying everything else from the parent:

   ```sql
   insert into whatsapp_templates
     ("key", purpose, language, style, meta_template_name, meta_language_code,
      parameter_format, variable_mapping, preview, is_active, is_default,
      sort_order, header_format, image_twin_of_key)
   select p."key" || '_logo', p.purpose, p.language, p.style || '_logo',
          '<twin name at Meta>', p.meta_language_code, p.parameter_format,
          p.variable_mapping, p.preview, false, false, p.sort_order,
          'image', p."key"
   from whatsapp_templates p
   where p."key" = '<parent key>' and p.header_format = 'none';
   ```

4. Press **Sync now** in **Admin › Templates**. Check the twin reads `approved` (the query below). The sync reads twins like any template.
5. Activate it: `update whatsapp_templates set is_active = true where "key" = '<parent key>_logo' and header_format = 'image';`. Sends pick it up within a minute (registry cache).
6. In **Admin › Stores**, open the store and switch **Logo header** on. The store detail lists every twin and its review status. The merchant then sees the logo card in **Settings** and uploads a logo.

To stop: switch the store's logo header off (its messages go back to text at once), or deactivate the twin for every store. Removing the logo in Settings also stops it for that store.

```sql
select t."key", t.image_twin_of_key, t.meta_template_name, t.is_active, t.review_status
from whatsapp_templates t
where t.header_format = 'image'
order by t."key";

select id, store_name, logo_header_enabled, logo_banner_url is not null as has_banner
from integrations
where logo_header_enabled
order by store_name;
```
