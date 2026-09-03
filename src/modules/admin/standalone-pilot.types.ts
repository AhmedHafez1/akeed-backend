import type { BillingPlanId } from '../../shared/billing/billing-plan';

export type PilotStatus =
  | 'eligible'
  | 'already_entitled'
  | 'skipped'
  | 'ambiguous';
export type PilotReason =
  | 'create_source'
  | 'activate_source'
  | 'already_entitled'
  | 'organization_missing'
  | 'native_source'
  | 'native_billing_history'
  | 'owner_missing'
  | 'multiple_owners'
  | 'multiple_owned_organizations'
  | 'source_conflict'
  | 'source_inactive'
  | 'billing_conflict'
  | 'accounting_anchor_missing';

export interface PilotSource {
  id: string;
  orgId: string;
  platformType: string;
  identity: string;
  isActive: boolean | null;
  billingPlanId: string | null;
  billingStatus: string | null;
  billingActivatedAt: string | null;
  billingStatusUpdatedAt: string | null;
  pendingBillingPlanId: string | null;
  billingInitiatedAt: string | null;
  billingCanceledAt: string | null;
  hasSubscription: boolean;
  hasCredentials: boolean;
  updatedAt: string | null;
}

export interface PilotSnapshot {
  orgId: string;
  organization: { id: string; name: string } | null;
  memberships: { id: string; userId: string; role: string | null }[];
  ownedOrganizations: { userId: string; orgId: string }[];
  sources: PilotSource[];
  identityConflict: boolean;
  claims: { id: string; platformType: string }[];
  usage: {
    id: string;
    integrationId: string;
    periodStart: string;
    consumedCount: number;
    blockedCount: number;
    includedLimit: number;
  }[];
  orderCount: number;
}

export interface PilotRow {
  orgId: string;
  organizationName: string | null;
  status: PilotStatus;
  reason: PilotReason;
  existingSource: boolean;
  source: Pick<
    PilotSource,
    | 'id'
    | 'identity'
    | 'platformType'
    | 'isActive'
    | 'billingPlanId'
    | 'billingStatus'
    | 'billingActivatedAt'
  > | null;
  proposed: {
    createSource: boolean;
    planId: BillingPlanId;
    billingStatus: 'not_required';
    includedLimit: number;
    billingActivatedAt: string | null;
  } | null;
}

export interface PilotEvaluation {
  row: PilotRow;
  fingerprint: string;
}
export interface PilotCounts {
  eligible: number;
  alreadyEntitled: number;
  skipped: number;
  existingSource: number;
  ambiguous: number;
}
export interface PilotPreviewEntry {
  orgId: string;
  fingerprint: string;
}
export interface PilotApplyResult {
  orgId: string;
  outcome:
    | 'activated'
    | 'already_applied'
    | 'unchanged'
    | 'skipped'
    | 'changed'
    | 'failed';
  reason:
    | PilotReason
    | 'preview_changed'
    | 'activation_failed'
    | 'already_applied';
  integrationId?: string;
  auditId?: string;
}
