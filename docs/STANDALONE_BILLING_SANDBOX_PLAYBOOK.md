# Standalone billing — sandbox-first playbook

Seven short sessions that prove Standalone Paymob billing end to end on a laptop. Each session has one goal and a **Done** check. Don't start the next session until the current one is done.

Everything used here already exists and passed `npm run test:gate:e045`. These sessions only configure and prove the flow; they write no payment code.

| Already in Akeed | Where |
| --- | --- |
| Paymob callback `POST /api/webhooks/payments/paymob` | `src/modules/billing/payments-callback.controller.ts` |
| HMAC check (forged callbacks get 401) | `src/infrastructure/spokes/paymob/paymob-hmac.guard.ts` |
| Amount, currency, integration, mode and order checks | `paymentEventMismatch` in `src/modules/billing/payment-callback.service.ts` |
| Ledger as source of truth; one grant per purchase | `credit_ledger_entries`, `credit_accounts` (database constraints) |
| Merchant purchase page and staff approval page | frontend `/[locale]/billing` and `/[locale]/admin/standalone-billing` |

Two Akeed rules shape the numbers below:

- A merchant must be **staff-approved** before credits work, and approval grants **30 free credits**.
- The smallest purchase is **100 credits = 200 EGP**, at 2 EGP per credit.

**Not in this playbook:** Vodafone Cash tests, refunds, chargebacks, production, reconciliation jobs and sign-off. See [After the milestone](#after-the-milestone).

In the SQL below, `<org>` is the merchant organization id.

## Session 1 — Paymob sandbox credentials

1. Open the Paymob dashboard in **Test mode**.
2. Put these values in `akeed-backend/.env`:
   ```env
   PAYMOB_MODE=test
   PAYMOB_BASE_URL=https://accept.paymob.com
   PAYMOB_SECRET_KEY=egy_sk_test_...
   PAYMOB_PUBLIC_KEY=egy_pk_test_...
   PAYMOB_HMAC_SECRET=...
   PAYMOB_CARD_INTEGRATION_ID=...
   PAYMOB_WALLET_INTEGRATION_ID=...
   PAYMOB_RETURN_URL=http://localhost:3001/billing/return
   ```
   Paymob enables mobile wallets per account on request, so a new sandbox often has only the card integration. In test mode you can leave `PAYMOB_WALLET_INTEGRATION_ID` empty: checkout then offers cards only. Never put a made-up id there — Paymob rejects the whole checkout for an integration the account doesn't have. Once Paymob enables the wallet, add its id (it must differ from the card id), but don't test the wallet yet. Live mode requires both ids.
3. Confirm `.env` is not tracked: `git check-ignore .env` must print `.env`.

**Done:** you have the secret key, public key, HMAC secret and card id (plus the wallet id if Paymob has enabled it), and `.env` is ignored.

## Session 2 — Paymob can reach your laptop

1. Apply migrations with `npm run db:migrate`. Then start Redis, the backend (`npm run start:dev`, port 3000) and the frontend (`npm run dev`, port 3001).
2. Open a tunnel with `ngrok http 3000`. Use your free static ngrok domain so the URL doesn't change between runs.
3. In `.env`, set `PAYMOB_CALLBACK_URL=https://<tunnel>/api/webhooks/payments/paymob` and `STANDALONE_CREDIT_BILLING_ENABLED=true`, then restart the backend. If a Paymob value is wrong, the backend refuses to start and names the variable.
4. In Paymob, set the card integration's *transaction processed callback* to the same URL.
5. Without paying, send a fake callback:
   ```bash
   curl -X POST https://<tunnel>/api/webhooks/payments/paymob -H "Content-Type: application/json" -d "{}"
   ```

**Done:** the request returns **401** and the backend logs `invalid_hmac`. The internet reaches Akeed, and forged callbacks are rejected.

## Session 3 — One approved merchant

1. Sign up at `http://localhost:3001` as a new Standalone merchant. The app shows "waiting for approval".
2. Enable the staff side, then restart the backend:
   - Give your staff Supabase user `akeed_role = admin`.
   - Set `ADMIN_CONTROL_TOWER_ENABLED=true` and `STANDALONE_CREDIT_APPROVAL_ENABLED=true`.
   - Locally only, set `ADMIN_REQUIRE_AAL2=false` unless your staff user has MFA.
3. Open `/en/admin/standalone-billing`, preview, and approve the merchant with a reason.

**Done:** the merchant's `/en/billing` page shows **30 credits** and one `free_grant +30`.

## Session 4 — First real sandbox card payment (the milestone)

1. As the merchant, open `/en/billing` and buy **100 credits** (200 EGP).
2. On the Paymob checkout, pay with a Paymob **test card**.
3. Paymob calls Akeed. In one transaction, Akeed verifies the HMAC and trusted fields, marks the purchase successful and adds exactly one ledger entry. The return page only shows the status; it can't add credits.
4. Check the database:
   ```sql
   SELECT reference, status, provider_transaction_id FROM payment_purchases WHERE org_id = '<org>' ORDER BY created_at DESC LIMIT 1;
   SELECT type, quantity, posted_balance_after FROM credit_ledger_entries WHERE org_id = '<org>' ORDER BY created_at;
   ```

**Done:** the purchase is `successful`, the ledger has `free_grant +30` then `purchase +100`, and the balance is **130**.

## Session 5 — Duplicate callback proof

1. Open the ngrok inspector at `http://127.0.0.1:4040`, find the Paymob POST, and click **Replay** — 1, 5 and 10 times.
2. Optional: use *Replay with modifications* to change one character of `hmac`. Expect 401 and no change.

**Done:** each replay returns 200 with outcome `duplicate_event`. This query returns **1**:

```sql
SELECT count(*) FROM credit_ledger_entries WHERE org_id = '<org>' AND type = 'purchase';
```

The balance stays **130**.

## Session 6 — Meta WhatsApp connectivity

1. Set these in `.env`: `WA_PHONE_NUMBER_ID`, `WA_BUSINESS_ACCOUNT_ID`, `WA_ACCESS_TOKEN`, `META_APP_SECRET`, and `WA_VERIFY_TOKEN` (any string you choose).
   - The `akeed_cod_verification…` templates must be approved in that WhatsApp account.
   - Add your phone as a test recipient.
2. In Meta, set the webhook to `https://<tunnel>/webhooks/whatsapp` with your `WA_VERIFY_TOKEN`, and subscribe to `messages`.
3. From the merchant Settings, send a **test message** to your own phone. It is a real send, so it uses 1 credit.
4. Check the database:
   ```sql
   SELECT kind, state, provider_message_id, accepted_at, delivered_at, read_at FROM verification_message_dispatches WHERE org_id = '<org>' ORDER BY created_at DESC LIMIT 3;
   ```

**Done:** the message arrives, the row has a `wamid…`, `delivered_at` or `read_at` is set, and the balance is **129**.

## Session 7 — Initial message and follow-up use credits

1. In Settings:
   - Enable follow-up.
   - Set the follow-up delay to **2 minutes** and the send delay to **0**.
   - Turn quiet hours off.
2. Create a **manual order** with your own phone as the customer. Don't reply.
3. The initial message uses 1 credit. About two minutes later, the follow-up uses 1 more.
4. Reconcile:
   ```sql
   SELECT type, quantity, posted_balance_after FROM credit_ledger_entries WHERE org_id = '<org>' ORDER BY created_at;
   SELECT (SELECT sum(quantity) FROM credit_ledger_entries WHERE org_id = '<org>') AS ledger_total, posted_balance, held_credits FROM credit_accounts WHERE org_id = '<org>';
   ```

**Done:** the ledger reads `+30` free, `+100` purchase, then `-1` three times (test, initial, follow-up). The balance is **127**, `ledger_total` equals `posted_balance`, and `held_credits` is 0.

## After the milestone

Do these later, one short session each, in the same Goal/Done style:

1. Vodafone Cash sandbox payment. Save the real wallet callback as a `sandbox-capture` fixture; see `src/infrastructure/spokes/paymob/fixtures/README.md`.
2. One sandbox refund. Confirm Paymob's refund callback shape matches what Akeed expects.
3. One real card payment and one real Vodafone Cash payment on an internal production organization.
4. Named go/no-go.

The [US-04.5-08 evidence](US-04.5-08-SANDBOX-AND-PRODUCTION-RELEASE-GATE-EVIDENCE.md) tracks the status of each item.
