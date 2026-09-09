import { createHash } from 'node:crypto';
import { buildStandaloneSourceIdentity } from '../../infrastructure/database/repositories/standalone-organization-provisioning.repository';
import type {
  ApprovalCounts,
  ApprovalEvaluation,
  ApprovalReason,
  ApprovalRow,
  ApprovalSnapshot,
  ApprovalStatus,
} from './standalone-billing.types';

/**
 * Decides whether staff may approve one organization for credit billing. The
 * conflict guards are inherited from the Standalone pilot: a Shopify or other
 * native source, ambiguous ownership or unexplained billing history is never
 * converted, only reported.
 */
export function evaluateStandaloneApproval(
  snapshot: ApprovalSnapshot,
  freeGrantQuantity: number,
  now = new Date(),
): ApprovalEvaluation {
  const source = snapshot.sources.length === 1 ? snapshot.sources[0] : null;
  const account = snapshot.account;
  const row: ApprovalRow = {
    orgId: snapshot.orgId,
    organizationName: snapshot.organization?.name ?? null,
    status: 'ambiguous',
    reason: 'organization_missing',
    existingSource: snapshot.sources.length > 0,
    source: source
      ? {
          id: source.id,
          identity: source.identity,
          platformType: source.platformType,
          isActive: source.isActive,
          billingPlanId: source.billingPlanId,
          billingStatus: source.billingStatus,
          billingActivatedAt: source.billingActivatedAt,
        }
      : null,
    account: account
      ? {
          ...account,
          availableCredits: Math.max(
            account.postedBalance - account.heldCredits,
            0,
          ),
        }
      : null,
    freeGrantPresent: snapshot.freeGrantPresent,
    proposed: null,
  };
  const result = (
    status: ApprovalStatus,
    reason: ApprovalReason,
  ): ApprovalEvaluation => ({
    row: { ...row, status, reason },
    fingerprint: createHash('sha256')
      .update(JSON.stringify(snapshot))
      .digest('hex'),
  });
  if (!snapshot.organization)
    return result('ambiguous', 'organization_missing');
  if (
    snapshot.sources.some(
      (candidate) => candidate.platformType !== 'standalone',
    )
  )
    return result('skipped', 'native_source');
  if (snapshot.claims.some((claim) => claim.platformType !== 'standalone'))
    return result('skipped', 'native_billing_history');
  const owners = snapshot.memberships.filter(
    (membership) => membership.role === 'owner',
  );
  if (owners.length === 0) return result('ambiguous', 'owner_missing');
  if (owners.length !== 1) return result('ambiguous', 'multiple_owners');
  if (
    snapshot.ownedOrganizations.filter(
      (owned) => owned.userId === owners[0].userId,
    ).length !== 1
  )
    return result('ambiguous', 'multiple_owned_organizations');
  if (
    snapshot.identityConflict ||
    snapshot.sources.length > 1 ||
    (source &&
      source.identity !== buildStandaloneSourceIdentity(snapshot.orgId))
  )
    return result('ambiguous', 'source_conflict');
  if (!account) return result('ambiguous', 'account_missing');
  // The immutable ledger, not the account row, is the authority on whether the
  // launch grant was already posted.
  if (account.status === 'active' || snapshot.freeGrantPresent)
    return result('already_approved', 'already_approved');
  if (account.status === 'suspended')
    return result('skipped', 'account_suspended');
  if (source && !source.isActive) return result('skipped', 'source_inactive');
  if (
    source &&
    (source.hasSubscription ||
      source.hasCredentials ||
      source.pendingBillingPlanId ||
      source.billingInitiatedAt ||
      source.billingCanceledAt)
  )
    return result('ambiguous', 'billing_conflict');
  const activation = source?.billingActivatedAt;
  const validAnchor =
    !!activation &&
    Number.isFinite(Date.parse(activation)) &&
    Date.parse(activation) <= now.getTime();
  if (activation && !validAnchor)
    return result('ambiguous', 'billing_conflict');
  if (
    source &&
    ((source.billingPlanId !== null && source.billingPlanId !== 'starter') ||
      (source.billingStatus !== null &&
        source.billingStatus !== 'not_required'))
  )
    return result('ambiguous', 'billing_conflict');
  if (
    !validAnchor &&
    (snapshot.usage.length > 0 ||
      snapshot.orderCount > 0 ||
      snapshot.claims.length > 0)
  )
    return result('ambiguous', 'accounting_anchor_missing');
  row.proposed = {
    createSource: !source,
    freeGrantQuantity,
    accountStatus: 'active',
    billingActivatedAt: activation ?? null,
  };
  return result('eligible', source ? 'activate_source' : 'create_source');
}

export function countApprovalRows(rows: ApprovalRow[]): ApprovalCounts {
  return rows.reduce<ApprovalCounts>(
    (counts, row) => ({
      eligible: counts.eligible + Number(row.status === 'eligible'),
      alreadyApproved:
        counts.alreadyApproved + Number(row.status === 'already_approved'),
      skipped: counts.skipped + Number(row.status === 'skipped'),
      ambiguous: counts.ambiguous + Number(row.status === 'ambiguous'),
      existingSource: counts.existingSource + Number(row.existingSource),
    }),
    {
      eligible: 0,
      alreadyApproved: 0,
      skipped: 0,
      ambiguous: 0,
      existingSource: 0,
    },
  );
}
