# US-08-07 — Message improvements

- **Epic:** [E08 — WhatsApp Template Management](README.md)
- **Delivery rank:** 7 of 8
- **Priority:** P1
- **Horizon:** NEXT
- **Story type:** Feature
- **Status:** Backlog
- **Dependencies:** [US-08-06](US-08-06-admin-create-edit-submit-activate-retire.md)

## User story and value

As a merchant's customer, I want a reminder that reads like a reminder, a short reply when I confirm or cancel, a nudge when my typed answer was not understood, my own dialect, my name or a polite word instead of "Customer", and an amount written the way I read money. Then the conversation feels clear and I confirm faster.

As a merchant, I want the Settings preview to show exactly what my customers receive.

**Business value:** closes gaps 3, 4, 6, 8, 10, 11 and 12, and the preview half of gap 2. Each improvement can be turned on, measured with US-08-02 and turned off on its own.

## Scope

Seven improvements. Each has its own switch, and every switch defaults to off:

| Item | Improvement | Switch (name proposed) |
| --- | --- | --- |
| a | Reminder purpose | `WHATSAPP_REMINDER_TEMPLATE_ENABLED` |
| b | Acknowledgment after confirm or cancel | `WHATSAPP_ACKNOWLEDGMENT_ENABLED` |
| c | Nudge after an unresolved typed reply | `WHATSAPP_UNRESOLVED_REPLY_NUDGE_ENABLED` |
| d | Arabic style by customer country | `WHATSAPP_ARABIC_STYLE_AUTO_ENABLED` |
| e | Localized name fallbacks | `WHATSAPP_LOCALIZED_FALLBACKS_ENABLED` |
| f | Amount formatting | `WHATSAPP_AMOUNT_FORMATTING_ENABLED` |
| g | Preview from the Meta snapshot | `NEXT_PUBLIC_SNAPSHOT_PREVIEW_ENABLED` plus a backend flag |

All new copy is drafted below for product-owner approval. Templates are created through the US-08-06 flow, never by hand in WhatsApp Manager.

**Out of scope:**
- Order items, address or delivery estimate (gap 5).
- More than one reminder.
- Changing reminder or no-reply timing.
- Broadening reply matching beyond what item c needs. For example, the unreachable `نعم.` and `لا.` entries are left for a separate fix.
- Merchant-written copy.

## Acceptance criteria

General:

1. Each item has its own switch, default off. With every switch off, the Meta payload stays byte-identical to the US-08-03 characterization suite on every path.
2. Each item's new copy exists in the registry only after US-08-06 review and approval (for templates) or US-08-06 activation (for free-form text, see open decision 2). No code path contains customer-facing message text.
3. Each new send or message records its identity and purpose (US-08-02), so every item can be measured on its own.

**a. Reminder purpose**

4. A `cod_reminder` purpose exists. With the switch on, a store's reminder uses its selected reminder template for the resolved language, or the language's reminder default.
5. With no sendable reminder template, the reminder falls back to the store's first-send template. That is today's behavior, and the reason is recorded. It never skips the reminder only because no reminder template exists.
6. Settings lets the merchant pick a reminder style per language among active `cod_reminder` templates. The settings response gains this field additively.

**b. Acknowledgment**

7. With the switch on, a short free-form message is sent once after a customer confirms or cancels, in the language of the verification's latest send. It is sent only inside the customer service window the US-08-01 record allows.
8. Outside the window, or when the text is unavailable, nothing is sent and the reason is recorded.
9. A merchant cancellation, an automatic `no_reply` and a test verification never trigger it.
10. A webhook replay never sends it twice.

**c. Nudge after an unresolved typed reply**

11. With the switch on, a typed reply that today is logged as `unresolved_reply` gets one free-form nudge asking the customer to tap a button. Conditions:
    - The reply must resolve to an open verification through its `context.id`.
    - At most one nudge per verification, ever.
    - Only inside the window.
12. The unresolved reply is stored as an event, without its text, so US-08-02 can count replies. The verification still runs out to `no_reply` as today if the customer never taps a button.

**d. Arabic style by customer country**

13. With the switch on, a store may choose `auto` as its Arabic style. `auto` picks Egyptian, Gulf or Standard from the phone's calling code, using the mapping in the draft below. If the picked style is not sendable, it falls back to the Arabic default with a recorded reason.
14. Stores that did not choose `auto` are unaffected.

**e. Localized name fallbacks**

15. With the switch on, a missing customer name and a missing store name use the approved per-language fallbacks below, not `Customer` and `Akeed Store`.
16. Akeed's own name never stands in for a missing store name.

**f. Amount formatting**

17. With the switch on, the `total` variable is formatted per language and currency as in the draft below. Decimal places follow the currency's minor unit.
18. An unknown currency uses its ISO code. A missing currency sends the number alone, as today.
19. Formatting never changes the amount.

**g. Preview from the Meta snapshot**

20. With the switch on, the merchant Settings Message tab (both skins) and the onboarding test phone render the selected template from the registry's Meta snapshot, with sample values. They use a neutral rendered-message type (lines plus button labels).
21. The four-block preview model (`greeting`, `body`, `totalLabel`, `ending`) is removed from the API, the frontend and the registry once the switch has been on in production through the gate.
22. Arabic renders RTL, and both locales show loading, empty and error states.
23. [`docs/MERCHANT_OPERATIONS.md`](../../MERCHANT_OPERATIONS.md) is corrected: its stale frontend paths and its tab names and redirects (`message`, `timing` and `plan` today). The merchant help page [`whatsapp-templates.md`](../../../../akeed-frontend/content/docs/en/whatsapp-templates.md) (en and ar) is updated to match what merchants now see.

## Copy drafts (draft, awaiting product-owner approval)

Variables use neutral keys. `{{customer}}`, `{{store}}`, `{{order}}` and `{{total}}` are filled at send time. Button payloads stay `confirm_<id>` and `cancel_<id>`.

### a. Reminder templates (`cod_reminder`)

| Language and style | Body | Buttons |
| --- | --- | --- |
| ar standard | مرحبًا {{customer}}، تذكير بطلبك 🔔<br>طلبك رقم #{{order}} من {{store}} بقيمة {{total}} ما زال بانتظار تأكيدك.<br>يرجى تأكيد الطلب لنبدأ تجهيزه للشحن، أو إلغاؤه إذا لم تعد ترغب فيه. | تأكيد الطلب / إلغاء الطلب |
| ar egyptian | أهلًا {{customer}}، بنفكّرك بطلبك 🔔<br>طلبك رقم #{{order}} من {{store}} بقيمة {{total}} لسه مستني تأكيدك.<br>أكّد دلوقتي عشان نجهّزه للشحن، أو ألغيه لو مش محتاجه. | تأكيد الطلب / إلغاء الطلب |
| ar gulf | هلا {{customer}}، نذكّرك بطلبك 🔔<br>طلبك رقم #{{order}} من {{store}} بقيمة {{total}} للحين بانتظار تأكيدك.<br>أكّده الحين عشان نجهّزه للشحن، أو ألغه إذا ما تبيه. | تأكيد الطلب / إلغاء الطلب |
| en friendly | Hi {{customer}}, a quick reminder 🔔<br>Your order #{{order}} from {{store}} for {{total}} is still waiting for your confirmation.<br>Please confirm so we can prepare it for shipping, or cancel if you no longer want it. | Confirm Order / Cancel Order |

Whether `professional`, `direct` and `short` get reminder versions, or use the language default reminder, is open decision 4.

### b. Acknowledgment (free-form)

| Event | Arabic | English |
| --- | --- | --- |
| Confirmed | شكرًا لك! تم تأكيد طلبك رقم #{{order}} من {{store}}، وسيتم تجهيزه للشحن. | Thank you! Your order #{{order}} from {{store}} is confirmed and will be prepared for shipping. |
| Canceled | تم إلغاء طلبك رقم #{{order}} من {{store}}. إذا كان ذلك عن طريق الخطأ، يرجى التواصل مع المتجر. | Your order #{{order}} from {{store}} has been cancelled. If this was a mistake, please contact the store. |

### c. Nudge (free-form)

| Arabic | English |
| --- | --- |
| عذرًا، لم نتمكن من فهم ردك. يرجى الضغط على أحد الزرين في الرسالة السابقة لتأكيد طلبك أو إلغائه. | Sorry, we couldn't understand your reply. Please tap one of the buttons in the message above to confirm or cancel your order. |

### d. Arabic style mapping for `auto`

| Calling code | Style |
| --- | --- |
| 20 (Egypt) | egyptian |
| 966, 971, 973, 974, 965, 968 (Saudi Arabia, UAE, Bahrain, Qatar, Kuwait, Oman) | gulf |
| Every other Arabic code in [`template-language.ts`](../../../src/shared/messaging/template-language.ts) | standard |

### e. Name fallbacks

| Missing | Arabic | English |
| --- | --- | --- |
| Customer name | عميلنا العزيز | there (reads as "Hi there!") |
| Store name | متجرنا | our store |

For example, "أهلًا بك عميلنا العزيز 👋" and "Thank you for shopping with our store."

### f. Amount format

| Currency | Arabic | English |
| --- | --- | --- |
| EGP | 1,250.00 ج.م | EGP 1,250.00 |
| SAR | 1,250.00 ر.س | SAR 1,250.00 |
| AED | 1,250.00 د.إ | AED 1,250.00 |
| KWD (3 decimals) | 1,250.000 د.ك | KWD 1,250.000 |
| QAR / BHD / OMR | ر.ق / د.ب / ر.ع after the number | ISO code before the number |
| USD | 1,250.00 $ | USD 1,250.00 |
| Unknown | ISO code after the number | ISO code before the number |

Western digits are proposed in both languages (open decision 6).

## Open decisions (product owner)

1. Approve, change or reject each copy draft above, individually.
2. **Free-form text and the registry (story and request differ).** The request says new copy is created through the US-08-06 flow, but acknowledgment and nudge are free-form messages, not Meta templates, so they cannot be submitted for review. Smallest fix, proposed: the registry gains a `free_form` kind that uses the same draft, activate, default and audit flow with no Meta submit step. Please confirm.
3. **Switch scope.** The proposal:
   - global environment switches for b, c, e, f and g;
   - a, and the `auto` option in d, are features a global switch makes available, after which each merchant opts in through Settings.
4. **Reminder versions.** Do only the defaults (ar standard, ar egyptian, ar gulf, en friendly) get reminder versions, or every style?
5. **Billing.** Do acknowledgment and nudge messages consume merchant usage or credits? The proposal is no. Are they recorded in the dispatch ledger, which is tied to billing, or in a separate message log? The proposal is a separate log.
6. **Number format.** Western digits (proposal) or Arabic-Indic digits in Arabic. Also: whole amounts with or without `.00`.
7. **Nudge without `context.id`.** The proposal is no nudge. Resolving by phone could pick another store's order.
8. **When the four-block model is removed (g).** The proposal is after US-08-08 go, in a follow-up commit within this story's scope.

## Implementation notes

- **Backend:**
  - Reminder selection extends the US-08-02 and US-08-03 selector for the `follow_up` kind.
  - Acknowledgment and nudge need a neutral `sendFreeFormText` on `MessagingPort`. The Meta spoke builds the text message and enforces the window rule from the record.
  - The trigger points are the confirm and cancel branches and the `unresolved_reply` branch in [`whatsapp.webhook.service.ts`](../../../src/infrastructure/spokes/meta/whatsapp.webhook.service.ts), which today has no messaging dependency. Sends are enqueued, not made inline in the webhook request.
  - Fallbacks today are hard-coded in [`whatsapp.service.ts`](../../../src/infrastructure/spokes/meta/whatsapp.service.ts). The total is built in [`verification-send.service.ts`](../../../src/modules/verification-core/verification-send.service.ts).
- **Frontend:**
  - Settings MessageTab (standalone and embedded skins), the onboarding test step, and [`templatePreview.ts`](../../../../akeed-frontend/src/shared/lib/templatePreview.ts) and [`messagePreview.ts`](../../../../akeed-frontend/src/features/settings/domain/messagePreview.ts) change for item g.
  - Reminder and `auto` choices are added to Settings.
  - All strings go through next-intl in `ar.json` and `en.json`.
- **Data:**
  - Migrations add:
    - the `cod_reminder` purpose and the `free_form` kind (open decision 2);
    - integration columns for the reminder key per language and for Arabic `auto`;
    - an unresolved-reply event store;
    - acknowledgment and nudge idempotency (one per verification per kind).
  - Each has a `_journal.json` entry and a rollback.
- **Operations:**
  - Document every switch in [`docs/ENVIRONMENT.md`](../../ENVIRONMENT.md).
  - Update [`docs/ORDER_CONFIRMATION_WORKFLOW.md`](../../ORDER_CONFIRMATION_WORKFLOW.md) and [`docs/INTEGRATIONS_WEBHOOKS_AND_AUTOMATION.md`](../../INTEGRATIONS_WEBHOOKS_AND_AUTOMATION.md) when each switch is enabled.

## Test requirements

- Per item, switch off: payload byte-identical (the characterization suite).
- Per item, switch on:
  - **a:** reminder template used; fallback to the first-send template with a reason.
  - **b:** sent once after a customer confirm and a customer cancel; not after a merchant cancel, `no_reply` or a test; not outside the window; replay-safe.
  - **c:** one nudge maximum; none without `context.id`; none outside the window; the event is stored without text.
  - **d:** each mapping row; fallback when the style is not sendable.
  - **e:** both fallbacks in both languages; never the Akeed name.
  - **f:** each currency row, KWD decimals, unknown currency, missing currency, amount unchanged.
  - **g:** the preview renders from the snapshot in both skins and in onboarding, in `ar` and `en`; error and empty states.
- The E01, E04, E05, E06 and E07 regressions pass untouched. All lint, typecheck, test and build commands pass in both repositories.

## Migration and rollout

- Additive migrations, all switches off.
- Enable one item at a time in dev, then prod, and compare its US-08-02 metrics over at least the period set at the gate before enabling the next.
- **Rollback:** turn the item's switch off. Removing the four-block model (item g) is the only non-additive step, and it happens last, after go.

## Evidence and references

**VERIFIED FROM CODE (2026-10-05):**
- The reminder resends the selected first-send template.
- Nothing is sent after a reply.
- Unresolved typed replies are only logged and need `context.id` ([`customer-reply-intent.ts`](../../../src/shared/verification/customer-reply-intent.ts), [`whatsapp.webhook.service.ts`](../../../src/infrastructure/spokes/meta/whatsapp.webhook.service.ts)).
- The fallbacks are `Customer` and `Akeed Store`.
- The total is `${totalPrice} ${currency}`.
- The preview is a backend-owned four-block copy.

**ASSUMPTION / REQUIRES VALIDATION:** the customer service window rules, whether free-form messages are allowed and their cost all come from the US-08-01 record. Items b and c stay off if the record leaves them UNKNOWN.

**EXTERNAL PLATFORM DEPENDENCY:** Meta template review for the reminder templates, and Meta free-form messaging rules.
