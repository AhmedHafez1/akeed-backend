# US-08-01 — Meta template contract record

- **Story:** [US-08-01 — Meta contract and live template reconciliation](../US-08-01-meta-contract-and-live-template-reconciliation.md)
- **Record date:** 2026-10-05
- **Baseline:** `akeed-backend` `develop` at `19c9e29`; kit commit `6acd898`
- **State:** DRAFT. Sections 1, 2 and 4 are written from the kit and from Meta's documentation. Sections 3, 5, 6 and 7, the supported table and the verdict wait for the first run of the script.
- **Verdict in one line:** not given yet.

This record is the only source of truth for Meta behavior in E08. Where it says UNKNOWN, do not fill the gap from memory or from Meta's public documentation: follow the worst-case rule written next to it, or stop and ask.

## Sources

Every page was read on 2026-10-05. Meta moved its WhatsApp documentation: the older `developers.facebook.com/docs/whatsapp/...` addresses now redirect into `developers.facebook.com/documentation/business-messaging/whatsapp/`. Pages were read through their `.md` renderings (the address below plus `.md`).

| Ref | Source | Graph version in its examples |
| --- | --- | --- |
| S1 | [Templates — overview](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview) | v23.0 |
| S2 | [Templates — components](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/components) | v25.0, v16.0 |
| S3 | [Templates — template management](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-management) | v23.0 |
| S4 | [Templates — review](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-review) | none |
| S5 | [Templates — categorization](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-categorization) | none |
| S6 | [Templates — quality rating](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-quality) | v25.0 |
| S7 | [Templates — pausing](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-pausing) | none |
| S8 | [Templates — pacing](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-pacing) | none |
| S9 | [Templates — archival](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-archival) | none |
| S10 | [Templates — time-to-live](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/time-to-live) | v21.0 |
| S11 | [Templates — supported languages](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/supported-languages) | none |
| S12 | [Templates — utility templates](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/utility-templates/utility-templates) | v23.0, v25.0 |
| S13 | [Webhooks — overview](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview) | none |
| S14 | [Webhooks — create a webhook endpoint](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint) | none |
| S15 | [Webhook reference — `message_template_status_update`](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/message_template_status_update) | none |
| S16 | [Webhook reference — `message_template_quality_update`](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/message_template_quality_update) | none |
| S17 | [Webhook reference — `template_category_update`](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/template_category_update) | none |
| S18 | [Webhook reference — `message_template_components_update`](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/message_template_components_update) | none |
| S19 | [Webhook reference — `messages`, button](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/button) | none |
| S20 | [Manage webhooks (`subscribed_apps`)](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/manage-webhooks) | v25.0 |
| S21 | [Messages — send messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages) | v25.0 |
| S22 | [Messages — text messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/text-messages) | v25.0 |
| S23 | [Messaging limits](https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits) | v25.0 |
| S24 | [Throughput](https://developers.facebook.com/documentation/business-messaging/whatsapp/throughput) | none |
| S25 | [Pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing) | none |
| S26 | [Access tokens](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens) | v25.0 |
| S27 | [Permissions](https://developers.facebook.com/documentation/business-messaging/whatsapp/permissions) | none |
| S28 | [Error codes](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes) | none |
| S29 | [Graph reference — WhatsApp Business Account `message_templates` edge](https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account/message_templates/) | page shows v26.0 |
| S30 | [Graph reference — WhatsApp message template node](https://developers.facebook.com/docs/graph-api/reference/whats-app-business-hsm/) | page shows v26.0 |
| S31 | [Graph API versions](https://developers.facebook.com/docs/graph-api/changelog/versions) | — |

The story names three Postman pages ([message templates](https://www.postman.com/meta/whatsapp-business-platform/folder/2l70wum/message-templates), [webhook payload reference](https://www.postman.com/meta/whatsapp-business-platform/folder/tduohwq/webhook-payload-reference), [Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api)). They load as an application and gave no readable content on 2026-10-05, so nothing in this record rests on them.

**Graph API version.** The application sends with **v24.0**: [`whatsapp.service.ts`](../../../../src/infrastructure/spokes/meta/whatsapp.service.ts) posts to `https://graph.facebook.com/v24.0/<phone-number-id>/messages`, and that is the only Graph call in the code. The kit pins the same version. S31 gives v24.0 as introduced on 2025-10-08 and available until 2028-02-18; the newest version is v26.0 (2026-07-29).

No page read here is written for v24.0: the guides use v21.0 to v25.0 in their examples and the reference pages show v26.0. A DOCUMENTED finding is therefore a statement about Meta's current documentation, not about v24.0. Only a VERIFIED finding says what v24.0 does on Akeed's account.

## How to read the labels

- **VERIFIED** — observed in a dated run of the kit on the Akeed dev or prod app.
- **DOCUMENTED** — stated on the source in the Source column, read on 2026-10-05. Not observed.
- **UNKNOWN** — neither observed nor stated on a page that was read. Each UNKNOWN has a worst-case rule, and the code follows that rule.
- **CODE** — a fact about Akeed's own code at the baseline commit. It says what Akeed sends today, not what Meta accepts.

## 1. The read-only script (AC 1)

The kit is [`scripts/spikes/whatsapp-templates/`](../../../../scripts/spikes/whatsapp-templates/README.md). It is not production code, and nothing in `src/` imports it.

| # | Finding | Label |
| --- | --- | --- |
| 1.1 | `list-templates.mjs` reads `WA_BUSINESS_ACCOUNT_ID` and `WA_ACCESS_TOKEN` from the process environment and nothing else. `--env dev\|prod` only names the output folder. | CODE |
| 1.2 | It calls one edge, `GET /v24.0/{WhatsApp Business Account ID}/message_templates`. The host and version are a constant with no override, and the one request call site hard-codes `GET` and takes no body. | CODE |
| 1.3 | It asks for `id`, `name`, `language`, `status`, `category`, `sub_category`, `previous_category`, `correct_category`, `quality_score`, `rejected_reason`, `parameter_format`, `components`, `message_send_ttl_seconds`, `cta_url_link_tracking_opted_out` and `library_template_name`, 100 per page, with the edge summary. A field v24.0 rejects is dropped and recorded. | CODE |
| 1.4 | It pages with `paging.cursors.after`. It reads `paging.next` only as a yes or no and never follows, stores or prints it. | CODE |
| 1.5 | It prints each template's name, language, status, category, quality and full components, and writes the same to `.tmp/spikes/whatsapp-templates/<env>/templates.json`. `.tmp` is gitignored (`.gitignore` line 45). | CODE |
| 1.6 | `reconcile.mjs` and `sanitize-fixture.mjs` read saved files and call nothing. | CODE |

## 2. Secrets (AC 2)

| # | Finding | Label |
| --- | --- | --- |
| 2.1 | The token travels only in the `Authorization` header. It is never part of a URL. | CODE |
| 2.2 | Everything printed or written passes through a scrubber that removes the token, its URL-encoded form, any `access_token=` parameter and any `Bearer` value. Before a file is written the script checks the text again and refuses to write if the token is in it. After a run it re-reads every file in the output folder. | CODE |
| 2.3 | An error report carries the HTTP status, Meta's error code and Meta's message, and nothing else from the response. Meta's trace ID, error type and subcode are not kept. | CODE |
| 2.4 | The app secret is not read by any script in the kit. | CODE |

**How it was confirmed (2026-10-05, kit commit `6acd898`).** `list-templates.mjs --self-test` runs the real code path against an in-process stub, with no network and no credentials. The stub returns a page whose `paging.next` carries the dummy token, a template whose text echoes the token, an error whose message echoes the token twice, and a thrown network error with the token in it. Result: `SELF-TEST PASS: 18 checks`. Standard output and standard error were captured to files, and those two files and the two files in the self-test output folder were searched for the dummy token: 0 matches in each. A search of the kit for `POST`, `PUT`, `PATCH`, `DELETE` and `method:` finds `method: 'GET'` at the one call site and the stub's own bookkeeping, and nothing else.

No request was sent to Meta to confirm this. The story's dry run against Meta with a made-up token is described in the kit README as an optional step for whoever holds a network path to Meta.

## 4. Meta's contract (AC 4)

### 4.1 Endpoints, permissions and tokens

| # | Finding | Label | Source |
| --- | --- | --- | --- |
| 4.1.1 | **List:** `GET /{WABA_ID}/message_templates`. Takes `fields`, `limit`, and filters including `status`, `category`, `language`, `name`, `quality_score`, `since` and `until`. Returns `data`, cursor `paging` (`cursors.before`, `cursors.after`, `next`) and an optional `summary` with `total_count`, `message_template_count`, `message_template_limit` and `are_translations_complete`. | DOCUMENTED | S3, S29 |
| 4.1.2 | **Read one:** `GET /{TEMPLATE_ID}` with `fields`. The node has `id` (a numeric string), `name`, `language`, `status`, `category`, `sub_category`, `previous_category`, `correct_category`, `quality_score`, `rejected_reason`, `parameter_format`, `components`, `message_send_ttl_seconds`, `cta_url_link_tracking_opted_out` and `library_template_name`. | DOCUMENTED | S30 |
| 4.1.3 | **Create:** `POST /{WABA_ID}/message_templates` with `name`, `language`, `category` and `components` required, and `parameter_format`, `allow_category_change`, `message_send_ttl_seconds`, `sub_category` and `library_template_name` optional. Returns `id`, `status` and `category`. | DOCUMENTED | S3, S29 |
| 4.1.4 | **Edit:** `POST /{TEMPLATE_ID}` with `category`, `components` or `message_send_ttl_seconds`. The guide's response example is `{"success": true}`; the reference lists `success`, `id`, `name` and `category`. | DOCUMENTED | S3, S30 |
| 4.1.5 | **Delete:** `DELETE /{WABA_ID}/message_templates`. With `name` alone it deletes every language of that name. With `hsm_id` and `name` it deletes that one template. `hsm_ids` takes up to 100 IDs. Returns `success`. | DOCUMENTED | S3, S29 |
| 4.1.6 | **Unpause:** `POST /{TEMPLATE_ID}/unpause`. | DOCUMENTED | S7 |
| 4.1.7 | **Archive and unarchive** can be done through the API in bulk. The endpoint and its parameters. | UNKNOWN | S3 and S9 name the feature only |
| 4.1.8 | Every template endpoint needs the `whatsapp_business_management` permission. `whatsapp_business_messaging` covers sending and the `messages` webhooks only. | DOCUMENTED | S3, S27, S29 |
| 4.1.9 | Accepted tokens are system user, business integration system user and user tokens. A direct developer uses a system user token in production, and that system user needs partial or full access to the WhatsApp Business Account. | DOCUMENTED | S26, S29 |
| 4.1.10 | An error body is `error.message`, `error.type`, `error.code`, `error.error_data.details`, `error.error_subcode` and `error.fbtrace_id`. Meta says to build handling on `code` and `details`, and that titles will be deprecated. | DOCUMENTED | S28 |
| 4.1.11 | Error codes named for template management: 100 invalid parameter, 190 token expired or invalid, 200 to 299 and 10 permission, 131009 invalid value, 139000 blocked by integrity, 4 app rate limit, 80007 account rate limit, 80008 rate limit, 2388039 status cannot be changed, 2388040 character limit, 2388047 header format, 2388072 body format, 2388073 footer format, 2388293 parameter-to-word ratio, 2388299 leading or trailing parameter. | DOCUMENTED | S28, S29, S30 |

**Worst-case rules:**

- **4.1.7.** Akeed does not archive or unarchive through the API. Unarchiving, if it is ever needed, is done by hand in WhatsApp Manager.
- **Unlisted error code.** A management error whose code is not in 4.1.11 is a failure with no automatic retry. A create or an edit is never retried automatically, whatever the code, because the first request may have been applied.
- **Permission.** The spoke treats 10 and 200 to 299 as "the token cannot manage templates" and says so to staff. It does not treat them as a template problem.

### 4.2 Review lifecycle and status values

| # | Finding | Label | Source |
| --- | --- | --- | --- |
| 4.2.1 | The API `status` values are `APPROVED`, `IN_APPEAL`, `PENDING`, `REJECTED`, `PENDING_DELETION`, `DELETED`, `DISABLED`, `PAUSED` and `LIMIT_EXCEEDED`. The list filter also accepts `ARCHIVED`. | DOCUMENTED | S29, S30 |
| 4.2.2 | A create call answers with `APPROVED`, `PENDING` or `REJECTED`. | DOCUMENTED | S5 |
| 4.2.3 | A review decision can take up to 24 hours. An appeal is also reviewed within 24 hours and must include a sample. | DOCUMENTED | S4 |
| 4.2.4 | Meta tells the business about a decision by a WhatsApp Manager notification, an email to the business admins and a webhook. | DOCUMENTED | S4 |
| 4.2.5 | Only an approved template can be sent. A paused template cannot be sent, a disabled template cannot be sent, and an archived template cannot be sent. | DOCUMENTED | S1, S7, S9 |
| 4.2.6 | Send errors that name the template's state: 132001 the template does not exist in that language or is not approved, 132015 paused for low quality, 132016 disabled after too many pauses, 132007 content violates a policy. | DOCUMENTED | S28 |
| 4.2.7 | **Pausing.** Low quality pauses a template for 3 hours the first time and 6 hours the second; the third time it is disabled. A pause ends by itself and the status returns to active. | DOCUMENTED | S7 |
| 4.2.8 | A rejected template can be edited and resubmitted, and an edited paused template goes back to review. S7 says a disabled template can be edited and resubmitted too, which the list of editable statuses in 4.3.1 does not include. | DOCUMENTED | S4, S7 |
| 4.2.9 | **Archival.** A template with no activity for 12 months is archived automatically, and deleted 28 days later. Activity is creating, editing, sending, appealing or unarchiving. No account can opt out. Unarchiving within the 28 days cancels the deletion and restores the previous status. A deleted template cannot be recovered. | DOCUMENTED | S3, S9 |
| 4.2.10 | The WhatsApp Manager labels are In review, Rejected, Active (quality pending, high, medium or low), Paused, Disabled and Appeal requested. They are a display of 4.2.1 and 4.5, not API values. | DOCUMENTED | S1 |
| 4.2.11 | What `LIMIT_EXCEEDED` and `IN_APPEAL` allow, and what the webhook-only events `FLAGGED`, `LOCKED` and `REINSTATED` mean for sending. | UNKNOWN | S15 lists the values without defining them |
| 4.2.12 | The API `status` and the webhook `event` a template shows when a pause ends. | UNKNOWN | S7 says "active"; S15 has an `UNPAUSE` title |

**Worst-case rules:**

- **Sendable.** A template is sendable at Meta only when its API `status` is exactly `APPROVED`. Every other value, including one this record does not list, maps to "not sendable". Quality does not change this: an approved template with a low quality score is still sendable (4.5.3).
- **4.2.11, 4.2.12.** A webhook event that is not `APPROVED` makes the template not sendable until a sync reads its `status` from the list endpoint. The list endpoint decides; the webhook only says "look again".
- **4.2.9.** A catalog variant that no store selects for 12 months will be archived and then deleted at Meta. The sync must report `ARCHIVED` on any registry row as loudly as `PAUSED`, because 28 days later the template is gone for good.

### 4.3 Editing an existing template

| # | Finding | Label | Source |
| --- | --- | --- | --- |
| 4.3.1 | Only a template whose status is `APPROVED`, `REJECTED` or `PAUSED` can be edited. | DOCUMENTED | S3 |
| 4.3.2 | An approved template can be edited up to 10 times in a 30-day window, or once in a 24-hour window. A rejected or paused template can be edited without limit. | DOCUMENTED | S3 |
| 4.3.3 | What can be edited: category, components and time-to-live. | DOCUMENTED | S3 |
| 4.3.4 | An edit replaces all components. One component cannot be edited on its own. | DOCUMENTED | S3 |
| 4.3.5 | The category of an approved template cannot be edited. | DOCUMENTED | S3 |
| 4.3.6 | After an approved or paused template is edited, "the API automatically re-approves the template unless it fails template review". | DOCUMENTED | S3 |
| 4.3.7 | An edit fires the `message_template_components_update` webhook with the new body, header, footer and buttons. | DOCUMENTED | S18 |
| 4.3.8 | The status an approved template shows between the edit and the re-approval, whether it can be sent in that time, and which text a customer receives. | UNKNOWN | S3 is silent |
| 4.3.9 | What an approved template becomes when its edit fails review: whether the approved text survives. | UNKNOWN | S3 is silent |
| 4.3.10 | Whether the 24-hour and 30-day windows roll or are calendar periods, and the error returned when a limit is hit. | UNKNOWN | S3 gives the numbers only |

**Worst-case rules:**

- **4.3.8.** From the moment an edit is sent, the template is not sendable until a sync or a webhook shows `APPROVED` again. Staff are told this before they confirm. Plan for up to 24 hours (4.2.3).
- **4.3.9.** Assume a failed edit leaves the template rejected and the old text gone. So a template that stores send today is never edited in place: new text is a new template, activated once it is approved. Editing is for rejected templates and for templates nothing sends.
- **4.3.10.** Akeed counts edits itself and refuses the second edit of an approved template within 24 hours of the first, and the eleventh within 30 days, both counted as rolling windows from Akeed's own record. A refusal from Meta is shown as it is and not retried.

### 4.4 What is fixed after creation

| # | Finding | Label | Source |
| --- | --- | --- | --- |
| 4.4.1 | A name is at most 512 characters of lowercase letters, digits and underscores. | DOCUMENTED | S1 |
| 4.4.2 | Name and language are not among the properties an edit can change (4.3.3), and the edit endpoint has no parameter for either. | DOCUMENTED | S3, S30 |
| 4.4.3 | A name groups its languages. Each name and language pair is its own template with its own ID, status, category and quality. Deleting by name alone deletes every language. | DOCUMENTED | S3, S29 |
| 4.4.4 | After an approved template is deleted, its name cannot be used for a new template for 30 days. | DOCUMENTED | S3 |
| 4.4.5 | A template deleted while a message using it is still undelivered becomes `PENDING_DELETION`, and delivery is attempted for 30 days. | DOCUMENTED | S3 |
| 4.4.6 | The category is fixed by Akeed once approved (4.3.5), but Meta can change it (4.5). | DOCUMENTED | S3, S5 |
| 4.4.7 | Whether `parameter_format` can be changed by an edit. The reference lists it as an edit parameter; the guide does not. | UNKNOWN | S3, S30 disagree |

**Worst-case rules:**

- **4.4.2.** Name and language are immutable. A rename or a new language is a new template with its own review.
- **4.4.3.** Akeed never deletes by name alone. If deletion is ever allowed (US-08-06 decision 4), it always sends the template ID with the name.
- **4.4.7.** An edit never changes the parameter format.

The two legacy names with a stray underscore, `_akeed_cod_verification_professional` and `akeed_cod_verification_direct_`, fit rule 4.4.1 as written. Since a name cannot change, they can only be kept or replaced by new templates.

### 4.5 Categories, quality and re-categorization

| # | Finding | Label | Source |
| --- | --- | --- | --- |
| 4.5.1 | A template is `AUTHENTICATION`, `MARKETING` or `UTILITY`. The list filter still accepts older category names. | DOCUMENTED | S1, S5, S29 |
| 4.5.2 | Quality is `GREEN` (high), `YELLOW` (medium), `RED` (low) or `UNKNOWN` (pending). A new template starts at `UNKNOWN`. It is based on usage, customer feedback and engagement. | DOCUMENTED | S6, S16 |
| 4.5.3 | A `RED` template that is still approved "can be sent, but is in danger of being paused or disabled soon". | DOCUMENTED | S6 |
| 4.5.4 | Meta checks the category when a template is created. Since 2025-04-09 it may assign a different category than the one asked for (`allow_category_change` is the default). A category that contradicts the guidelines is rejected with reason `INCORRECT_CATEGORY`. | DOCUMENTED | S5 |
| 4.5.5 | Meta re-categorizes an approved utility template as marketing when its content calls for it. The business gets 24 hours' notice, or none if it has been warned for abuse. The status stays `APPROVED` and the template keeps working. | DOCUMENTED | S5 |
| 4.5.6 | Akeed is told by an email to the account admins and by the `template_category_update` webhook: once when the change is scheduled, with `correct_category` and `category_update_timestamp`, and once when it is done, with `previous_category` and `new_category`. | DOCUMENTED | S5, S17 |
| 4.5.7 | The node carries `previous_category` and `correct_category`, so a sync can see a past or a coming change. | DOCUMENTED | S30 |
| 4.5.8 | A category change can be appealed within 60 days, through Business Support. | DOCUMENTED | S5 |
| 4.5.9 | The charge follows the category at the time of sending. Marketing is always charged. A utility template delivered inside an open customer service window is free. | DOCUMENTED | S25 |
| 4.5.10 | Sending marketing as utility repeatedly leads to no-notice changes, then a cap on utility volume, then every utility template being made marketing and utility creation being switched off for 7 to 30 days. | DOCUMENTED | S5 |
| 4.5.11 | Utility templates are paced (held, then released or dropped with code 132015) only for 7 days after a utility template of the account was paused. | DOCUMENTED | S8 |
| 4.5.12 | Two send errors exist that a utility message is not expected to meet: 131049, not delivered "to maintain healthy ecosystem engagement", and 131050, the recipient has stopped marketing messages. | DOCUMENTED | S28 |
| 4.5.13 | How many of Akeed's confirmations those two rules would stop if a template became marketing. | UNKNOWN | S28 names the codes only |

**Worst-case rule for 4.5.13 and US-08-04 decision 5.** A template whose category at Meta is no longer the category Akeed registered stays sendable, because Meta keeps it approved, but it is a staff alert of the same weight as a pause: its messages now cost more and some will not be delivered. Whether Akeed stops sending it is the product owner's decision; until that decision the code alerts and keeps sending.

### 4.6 Parameters

| # | Finding | Label | Source |
| --- | --- | --- | --- |
| 4.6.1 | A template's parameters are `named` or `positional`. Without a format the template is positional. The API field is `parameter_format` with `NAMED` and `POSITIONAL`. | DOCUMENTED | S1, S29 |
| 4.6.2 | A named parameter is unique, lowercase letters and underscores, in double braces: `{{first_name}}`. | DOCUMENTED | S1 |
| 4.6.3 | A positional parameter is `{{1}}`, `{{2}}` and so on, starting at 1. | DOCUMENTED | S1 |
| 4.6.4 | Each parameter needs an example value when the template is created: `example.body_text_named_params` as a list of `{ param_name, example }`, or `example.body_text` as a nested list for positional. | DOCUMENTED | S1, S2, S12 |
| 4.6.5 | A send carries a named value as `{ "type": "text", "parameter_name": "<name>", "text": "<value>" }` in the body component's `parameters`. | DOCUMENTED | S12 |
| 4.6.6 | Akeed sends named values exactly so, and positional values as `{ "type": "text", "text": "<value>" }` in `bodyParameterOrder`. | CODE | [`whatsapp.service.ts`](../../../../src/infrastructure/spokes/meta/whatsapp.service.ts) |
| 4.6.7 | The body is at most 1024 characters. A text header is at most 60 characters with one parameter; a footer at most 60 characters. | DOCUMENTED | S2 |
| 4.6.8 | A parameter may not start or end the body (2388299), and the ratio of parameters to words is limited (2388293). Review also rejects mismatched braces, special characters in a parameter, and positional numbers that skip. | DOCUMENTED | S4, S28 |
| 4.6.9 | A send with the wrong number of values fails with 132000; wrongly formatted values with 132012. | DOCUMENTED | S28 |
| 4.6.10 | The language list has `ar`, `ar_EG`, `ar_AE`, `ar_LB`, `ar_MA` and `ar_QA` for Arabic, and `en`, `en_US`, `en_GB` and other regional codes for English. `ar_SA` is not on it. | DOCUMENTED | S11 |
| 4.6.11 | Whether the order of named values in a send matters. | UNKNOWN | not stated on S1, S2 or S12 |
| 4.6.12 | Limits on a parameter value in a send: its length, line breaks, and the length of the filled body. | UNKNOWN | not stated on a page that was read |
| 4.6.13 | Whether Meta falls back from one language code to another (for example `ar_EG` to `ar`) when the code sent has no template. | UNKNOWN | S11 is silent; S28 gives 132001 for a missing language |
| 4.6.14 | The exact parameter-to-word ratio. | UNKNOWN | S28 names the error only |

**Worst-case rules:**

- **4.6.11.** Named values are sent in the order the catalog lists them today, per variant, and that order does not change (it is part of the byte-identical baseline).
- **4.6.12.** No new code sends a value that today's code would not. A neutral validation rule for new templates keeps every sample single-line and the filled sample body under 1024 characters. A refusal on a real send is already a recorded rejection.
- **4.6.13.** The language code sent is exactly the code the template is registered under. There is no fallback between codes.
- **4.6.14.** Local validation does not guess the ratio. It warns when a body has more than one parameter per three words and leaves the decision to Meta's review.

### 4.7 Quick-reply buttons

| # | Finding | Label | Source |
| --- | --- | --- | --- |
| 4.7.1 | A template has at most 10 buttons in total and at most 10 quick-reply buttons. | DOCUMENTED | S2 |
| 4.7.2 | A quick-reply label is at most 25 characters. | DOCUMENTED | S2 |
| 4.7.3 | Quick-reply buttons must sit together: quick reply, quick reply, URL is valid; quick reply, URL, quick reply is not. | DOCUMENTED | S2 |
| 4.7.4 | With four or more buttons the customer sees two and a "See all options" entry. | DOCUMENTED | S2 |
| 4.7.5 | A quick-reply button is created as `{ "type": "QUICK_REPLY", "text": "<label>" }` inside a `buttons` component (S12 writes the type in lowercase). The creation syntax has no payload. | DOCUMENTED | S2, S12 |
| 4.7.6 | Akeed sets the payload at send time: one `button` component per button, `sub_type: "quick_reply"`, `index` 0 with `confirm_<verificationId>` and `index` 1 with `cancel_<verificationId>`. | CODE | [`whatsapp.service.ts`](../../../../src/infrastructure/spokes/meta/whatsapp.service.ts) |
| 4.7.7 | A tap arrives on the `messages` field as a message of type `button` with `button.payload`, `button.text` and `context.id`, the ID of the template message. | DOCUMENTED | S19 |
| 4.7.8 | The maximum length of a quick-reply payload. | UNKNOWN | S2 and S19 state none |
| 4.7.9 | The shape of the send-time button component, as Meta documents it. | UNKNOWN | not on a page that was read; 4.7.6 is what works today |

**Worst-case rules:**

- **4.7.8, 4.7.9.** The send-time button components stay exactly as 4.7.6: two components, those payloads (44 and 43 characters), those indexes. No E08 story lengthens a payload or adds a third button.
- **Index order.** `index` 0 is the first button as registered at Meta. A template whose first button is not its confirm button would deliver "cancel" for a confirm tap. Section 6 checks this for the 8 variants; US-08-06 validation must check it for every new template.

### 4.8 Webhooks

| # | Finding | Label | Source |
| --- | --- | --- | --- |
| 4.8.1 | The template fields are `message_template_status_update`, `message_template_quality_update`, `template_category_update` and `message_template_components_update`. | DOCUMENTED | S13 |
| 4.8.2 | Fields are chosen per app, in **App Dashboard > WhatsApp > Configuration**. The app must also be subscribed to the WhatsApp Business Account (`POST /{WABA_ID}/subscribed_apps`; `GET` lists the subscribed apps). Everything is delivered to the app's one callback URL. | DOCUMENTED | S13, S20 |
| 4.8.3 | The `messages` field needs `whatsapp_business_messaging`. Every other field, so all four template fields, needs `whatsapp_business_management`. | DOCUMENTED | S13, S27 |
| 4.8.4 | The envelope is the one `messages` uses: `object` is `whatsapp_business_account`; `entry[].id` is the WhatsApp Business Account ID; `entry[].time` is a Unix time in seconds; `entry[].changes[]` has `field` and `value`. | DOCUMENTED | S15 to S18 |
| 4.8.5 | Every delivery is signed the same way: `X-Hub-Signature-256` is the HMAC-SHA256 of the payload with the app secret. | DOCUMENTED | S14 |
| 4.8.6 | **Status.** `value` has `event`, `message_template_id`, `message_template_name`, `message_template_language`, `reason` and `message_template_category`, and may have `disable_info.disable_date`, `other_info.title` and `.description`, and `rejection_info.reason` and `.recommendation`. | DOCUMENTED | S15 |
| 4.8.7 | `event` is one of `APPROVED`, `ARCHIVED`, `UNARCHIVED`, `DELETED`, `DISABLED`, `FLAGGED`, `IN_APPEAL`, `LIMIT_EXCEEDED`, `LOCKED`, `PAUSED`, `PENDING`, `REINSTATED`, `PENDING_DELETION` or `REJECTED`. | DOCUMENTED | S15 |
| 4.8.8 | `reason` is one of `ABUSIVE_CONTENT`, `CATEGORY_NOT_AVAILABLE` (deprecated), `INCORRECT_CATEGORY`, `INVALID_FORMAT`, `NONE`, `PROMOTIONAL`, `SCAM` or `TAG_CONTENT_MISMATCH`, and is null for a scheduled deletion. `other_info.title` is one of `FIRST_PAUSE`, `SECOND_PAUSE`, `RATE_LIMITING_PAUSE`, `UNPAUSE` or `DISABLED`. | DOCUMENTED | S15 |
| 4.8.9 | **Quality.** `value` has `previous_quality_score`, `new_quality_score` (each `GREEN`, `YELLOW`, `RED` or `UNKNOWN`), and the template ID, name and language. | DOCUMENTED | S16 |
| 4.8.10 | **Category.** Scheduled change: `new_category` (the current one), `correct_category` and `category_update_timestamp`. Completed change: `previous_category` and `new_category`. Both carry the template ID, name and language. | DOCUMENTED | S17 |
| 4.8.11 | **Components.** Sent when a template is edited: `message_template_element` (body), `message_template_title` (header), `message_template_footer` and `message_template_buttons[]`, with the template ID, name and language. | DOCUMENTED | S18 |
| 4.8.12 | `message_template_id` is an integer in all four payloads. The API's `id` is a numeric string. | DOCUMENTED | S15 to S18, S30 |
| 4.8.13 | A failed delivery is retried at once, then with decreasing frequency for 7 days. Retries can produce duplicates, and "your server should handle deduplication". A payload can be up to 3 MB. The expected answer is `200`. | DOCUMENTED | S13, S14 |
| 4.8.14 | No payload has an event ID or a delivery ID. `entry[].time` is the only time in the envelope. | DOCUMENTED | S15 to S18 |
| 4.8.15 | Whether deliveries arrive in order, and whether a retry repeats the original `entry[].time`. | UNKNOWN | no page says |
| 4.8.16 | The form of `message_template_language`. The examples show `en-US` and `en` on S15, `en-US` on S16 and S17, and `en_US` on S18, while the API uses `en_US`. | UNKNOWN | the examples disagree |
| 4.8.17 | Which optional members come with each `event`, and which `event` a pause ending produces. | UNKNOWN | S15 has examples for `APPROVED` and `REJECTED` only |
| 4.8.18 | How quickly the answer must come back. | UNKNOWN | S14 gives no time |

**Worst-case rules for US-08-04:**

- **Truth.** A webhook is a hint; the list endpoint is the truth. A template webhook updates the registry and schedules a sync of that template. If the two disagree, the sync wins.
- **Identity (4.8.12, 4.8.16).** A webhook is matched to a registry row by template name and language, with `-` and `_` treated as the same character in the language code. The template ID is compared as a string and only as a second check: an integer above 2^53 does not survive a JSON parse, so the ID is never the only key.
- **Duplicates (4.8.14).** With no event ID, the identity of an event is the field, `entry[].id`, `entry[].time`, and a hash of `value`. The same identity twice is a no-op.
- **Order (4.8.15).** An event is applied only if its `entry[].time` is later than the last one applied for that template and field. An earlier one is stored and ignored. The same second with a different `value` is not ordered by guesswork: it triggers a sync.
- **Unknown values (4.8.17).** An `event`, score or category that this record does not list maps to the neutral `unknown`, which is not sendable, and triggers a sync.
- **Wrong account.** `entry[].id` must equal the environment's `WA_BUSINESS_ACCOUNT_ID`. Anything else is logged and dropped.
- **Speed (4.8.18).** Template fields are stored and answered `200` at once, exactly like `messages`. Nothing waits on a sync before the answer.
- **Unregistered template.** A webhook for a template with no registry row is reported, not created.

The `messages` handling does not change. Today [`whatsapp.webhook.service.ts`](../../../../src/infrastructure/spokes/meta/whatsapp.webhook.service.ts) reads only `value.messages` and `value.statuses` and the DTO has no `field`, so a template delivery that arrived today would be acknowledged and ignored.

### 4.9 Rate limits

| # | Finding | Label | Source |
| --- | --- | --- | --- |
| 4.9.1 | At most 100 templates can be created in a WhatsApp Business Account per hour. | DOCUMENTED | S1 |
| 4.9.2 | An account holds at most 250 templates when its business portfolio is unverified, and up to 6,000 when the portfolio is verified and a number has an approved display name. The list summary reports the count and the limit. | DOCUMENTED | S1, S29 |
| 4.9.3 | Edits: 4.3.2. | DOCUMENTED | S3 |
| 4.9.4 | The rate-limit errors are 4 (the app), 80007 (the account) and 80008. | DOCUMENTED | S28, S29 |
| 4.9.5 | How many management calls per hour are allowed. | UNKNOWN | not on a page that was read |
| 4.9.6 | **Sends.** A number sends up to 80 messages per second, 1,000 after an automatic upgrade. Above that the API answers 130429. Too many messages to one recipient answers 131056. | DOCUMENTED | S24, S28 |
| 4.9.7 | **Messaging limit.** The number of unique customers a business can message outside a customer service window in a moving 24 hours: 250, 2,000, 10,000, 100,000 or unlimited. It is set for the business portfolio and shared by its numbers. | DOCUMENTED | S23 |
| 4.9.8 | A send response carries `messages[].message_status` for template messages only. The documented example value is `accepted`. Messages of a paced template are held, then released or dropped. | DOCUMENTED | S8, S12, S21 |
| 4.9.9 | A message not delivered within its time-to-live is dropped. The default for a utility template is 30 days, and it can be set from 30 seconds to 12 hours. | DOCUMENTED | S10 |

**Worst-case rule for 4.9.5.** The scheduled sync runs at most once an hour per environment (the story proposes every 6 hours) and reads 100 templates per call. An on-demand sync is single-flight with a cooldown. On 4, 80007 or 80008 the sync stops, records the code and waits for its next scheduled run; it never loops. E08 changes nothing about how often messages are sent.

### 4.10 Free-form messages

| # | Finding | Label | Source |
| --- | --- | --- | --- |
| 4.10.1 | "When a WhatsApp user messages you or calls you, a 24-hour timer called a customer service window starts." Another message or call before it ends resets it to 24 hours. | DOCUMENTED | S21 |
| 4.10.2 | While the window is open any service message can be sent, text included. When it closes only template messages can be sent. | DOCUMENTED | S21 |
| 4.10.3 | A free-form message sent more than 24 hours after the customer's last message fails with 131047. | DOCUMENTED | S28 |
| 4.10.4 | A text message is `POST /{PHONE_NUMBER_ID}/messages` with `type: "text"` and `text.body` of at most 4096 characters. | DOCUMENTED | S21, S22 |
| 4.10.5 | Non-template messages are free. | DOCUMENTED | S25 |
| 4.10.6 | Messages sent in a series are not guaranteed to be delivered in the order they were requested. | DOCUMENTED | S21 |
| 4.10.7 | The messaging limit counts only messages outside a window, so a free-form reply does not use it. | DOCUMENTED | S23 |
| 4.10.8 | Whether a tap on a quick-reply button counts as the customer messaging Akeed, and so opens the window. S19 says a tap arrives as a message; S21 does not mention buttons. | UNKNOWN | S19, S21 |
| 4.10.9 | Akeed sends no free-form message today. The messaging port has one send method, `sendVerificationTemplate`. | CODE | [`messaging.port.ts`](../../../../src/shared/ports/messaging.port.ts) |

**Worst-case rule for 4.10.8 and US-08-07.** A free-form message after a button tap is best effort. It is sent once and never retried. 131047 is an expected, recorded skip, not a failure. The verification outcome is final before the message is attempted and never depends on it. US-08-08 turns 4.10.8 into VERIFIED by tapping a button on the dev app and sending one text.

## Documentation discrepancies

Found while reading. Each is handled by a rule above.

- **The name of the status webhook.** S4 calls it `message_template_status_change`. The field to subscribe to is `message_template_status_update` (S13, S15).
- **Editing a disabled template.** S7 says a disabled template can be edited and resubmitted. S3 allows edits only for `APPROVED`, `REJECTED` and `PAUSED`. Akeed follows S3.
- **Permissions for reading a template.** S29 names `whatsapp_business_management` for the list edge. S30 lists `whatsapp_business_management`, `whatsapp_business_messaging` and `public_profile` for the node.
- **The edit response.** S3 shows `{"success": true}`. S30 lists `success`, `id`, `name` and `category`. Akeed reads `success` only.
- **`ARCHIVED`.** It is a list filter value on S29 and a webhook event on S15, and it is missing from the status values on S30.
- **Language codes in webhooks.** `en-US` on S15, S16 and S17; `en_US` on S18 and in the API (4.8.16).
- **Where time-to-live is set.** S10 writes the call as `POST /<PHONE_NUMBER_ID>/message_templates`. Every other page creates templates on the WhatsApp Business Account. Akeed uses the account, and does not set a time-to-live in E08.
- **`template_category_update` syntax.** The payload syntax on S17 shows `new_category` twice. The two examples on the same page are consistent, and 4.8.10 follows them.
- **Button type casing.** `QUICK_REPLY` on S2, `quick_reply` on S12.
- **Graph versions.** The examples run from v16.0 to v25.0 and the reference pages show v26.0. None is v24.0.
