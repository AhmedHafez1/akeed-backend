# Admin SQL scripts

Scripts to paste into the Supabase SQL editor. They are not migrations and nothing in the app runs them.

| Script | What it does |
| --- | --- |
| `delete-organization.sql` | Deletes one organization and every row linked to it. |
| `delete-user.sql` | Deletes one user from `auth.users`, their memberships, and every organization where they are the only member. |

## How to run

1. Open the script in the SQL editor as the default `postgres` role.
2. Set `v_target` under `SETTINGS`. For an organization, use its id or slug. For a user, use their email or id.
3. Leave `v_dry_run` as `true` and run. The result lists every table and how many rows would go. Nothing is changed.
4. Check the list. Set `v_dry_run` to `false` and run again to delete.

If anything fails, the whole run is rolled back and the error says why.

## What to expect

- **Organizations with other members are kept.** `delete-user.sql` only removes the user's membership there, and lists the organization as `KEPT`. If the user is its only owner, the script stops and names the organization.
- **Free-plan claims are deleted.** The app keeps `billing_free_plan_claims` after an organization is removed, so a store cannot claim the free plan twice. These scripts remove the claim, so the store can claim it again. Remove that step if you clean up a real customer and want the block to stay.
- **`LEFT IN PLACE` rows are not errors.** They are rows in a kept organization or in shared staff history that record the user's id as the actor, in a column with no foreign key.
- **Credit history is deleted.** The scripts switch off `credit_ledger_immutable` and `payment_purchase_no_delete` for the length of the transaction, then switch them back on. Other sessions cannot write to those two tables until the script ends.
- **Only the database is touched.** The scripts do not uninstall the app at Shopify, EasyOrders or WooCommerce, and do not remove queued jobs from Redis.

## Keeping them up to date

The two scripts repeat the same organization steps, so change both together.

A new table with an `org_id` column needs a change here only if it points at `orders`, `integrations` or `credit_accounts` without `ON DELETE CASCADE`. In that case add a `DELETE` for it before its parent. If you forget, the scripts fail with a foreign-key error or with `Table ... still has ... row(s)`, and change nothing.

A new table that links to an organization without an `org_id` column (as `provider_message_receipts` does through the message id) is not caught by that check. Add it to step 1 in both scripts.
