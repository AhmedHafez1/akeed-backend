import { createHash } from 'node:crypto';
import { resolveEntitlement } from '../../shared/billing/entitlement';
import { resolveIncludedVerificationsLimit } from '../../shared/billing/billing-plan';
import { buildStandaloneSourceIdentity } from '../../infrastructure/database/repositories/standalone-organization-provisioning.repository';
import type {
  PilotCounts,
  PilotEvaluation,
  PilotReason,
  PilotRow,
  PilotSnapshot,
  PilotStatus,
} from './standalone-pilot.types';

export function evaluateStandalonePilot(
  snapshot: PilotSnapshot,
  now = new Date(),
): PilotEvaluation {
  const source = snapshot.sources.length === 1 ? snapshot.sources[0] : null;
  const row: PilotRow = {
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
    proposed: null,
  };
  const result = (
    status: PilotStatus,
    reason: PilotReason,
  ): PilotEvaluation => ({
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
    resolveEntitlement(source, { id: source.id, orgId: snapshot.orgId }, now)
      .allowed
  )
    return result('already_entitled', 'already_entitled');
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
    planId: 'starter',
    billingStatus: 'not_required',
    includedLimit: resolveIncludedVerificationsLimit('starter'),
    billingActivatedAt: activation ?? null,
  };
  return result('eligible', source ? 'activate_source' : 'create_source');
}

export function countPilotRows(rows: PilotRow[]): PilotCounts {
  return rows.reduce<PilotCounts>(
    (counts, row) => ({
      eligible: counts.eligible + Number(row.status === 'eligible'),
      alreadyEntitled:
        counts.alreadyEntitled + Number(row.status === 'already_entitled'),
      skipped: counts.skipped + Number(row.status === 'skipped'),
      ambiguous: counts.ambiguous + Number(row.status === 'ambiguous'),
      existingSource: counts.existingSource + Number(row.existingSource),
    }),
    {
      eligible: 0,
      alreadyEntitled: 0,
      skipped: 0,
      ambiguous: 0,
      existingSource: 0,
    },
  );
}
