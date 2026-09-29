# Standalone onboarding v2

Status: approved design, 29 Sep 2026. Mockups: "Akeed Standalone Onboarding" design canvas (Claude artifact).

## Goal
Signup to first real WhatsApp confirmation as fast as possible, for merchants without Shopify. Standalone should be a sibling of Shopify embedded onboarding v2, not a copy: same philosophy (one short form, prove it on your own phone, then go live), with a platform-appropriate implementation.

## Screen sequence
1. Signup: name, store name, email, password, terms. There is no confirm-password field.
2. Verify email: resend with a cooldown, change email, and a preview of the next steps.
3. Your store (/onboarding?step=store): store name (prefilled from signup) and the merchant's WhatsApp number. Language, currency and timezone are pre-chosen and shown in a DefaultsWell with a "Change" button on each.
4. Try the message (/onboarding?step=test): the free test to the merchant's own WhatsApp, a live timeline, resend, change number, and a quiet skip.
5. You're live (/onboarding?step=done): a 3-stage pipeline, the credits in numbers, and the primary action "Add your first order".
6. Dashboard first-run: one "first real confirmation" card with two ways to add orders (manual, file). KPIs and top-bar actions stay hidden until the first order exists.

## Decisions
- Remove from onboarding: the confirmation-rules step, the review step, the auto-verify switch, "Save progress", and WelcomeCreditsModal.
- Auto-verify is always on for standalone. Manual orders are rejected when it is off.
- Defaults: language auto; currency from the merchant phone's country; timezone from the browser if it is in the curated list, else from the phone country; first send immediate; one follow-up after 2 h; escalation after 6 h; quiet hours off; COD fallback false.
- Completion: call POST /api/onboarding/complete only when the test is confirmed, skipped, or WhatsApp is unavailable, never on the Your store submit. The onboarding test (/api/onboarding/test) is billing-exempt and works while onboarding is pending.
- The success screen renders in place after /complete, with no navigation, so AuthGuard does not redirect. A refresh lands on the dashboard first-run, which carries the same next step.
- Messages go out from Akeed's own WhatsApp number. The merchant connects nothing; "WhatsApp setup" means only their own number for the test.
- Progress uses the design-system Stepper ("الحساب · متجرك · جرّب الرسالة") in the focused onboarding top bar. The account step always shows as done. Below 640 px it becomes "3 من 3 · جرّب الرسالة" plus a thin progress bar.
- One primary button per view, named by its result. Reassurance appears once, as a caption next to the action it is about.
- Embedded (Shopify) onboarding is not changed. Shared: logic, models, copy structure, WhatsAppPhonePreview. Not shared: Polaris styling.

## States
- Validation: warning-style field error plus one line saying what to type; focus the first invalid field.
- Loading: skeletons the size of the content; the primary is disabled.
- Save failed: one danger banner; the values are kept.
- Test states: sending, waiting for tap, tapped Cancel (explained), not delivered (Change number becomes the primary), daily limit, Akeed WhatsApp unavailable (warning banner, "the problem is ours, settings saved, no credit used", primary "Continue to dashboard").
- Skipped test: an info banner in the dashboard first-order card, with "أرسلها إلى هاتفي".
- Balance at zero: the first-order card shows the balance and links to buying credits.
- Suspended account and viewer role: keep the current behaviour.