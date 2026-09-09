import type { CreditAccountStatus } from '../../shared/ports/credit-accounting.port';

export type ApprovalStatus =
  | 'eligible'
  | 'already_approved'
  | 'skipped'
  | 'ambiguous';
export type ApprovalReason =
  | 'create_source'
  | 'activate_source'
  | 'already_approved'
  | 'organization_missing'
  | 'native_source'
  | 'native_billing_history'
  | 'owner_missing'
  | 'multiple_owners'
  | 'multiple_owned_organizations'
  | 'source_conflict'
  | 'source_inactive'
  | 'billing_conflict'
  | 'accounting_anchor_missing'
  | 'account_missing'
  | 'account_suspended';

export interface ApprovalSource {
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

export interface ApprovalAccount {
  status: CreditAccountStatus;
  postedBalance: number;
  heldCredits: number;
  version: number;
  approvedAt: string | null;
}

export interface ApprovalSnapshot {
  orgId: string;
  organization: { id: string; name: string } | null;
  memberships: { id: string; userId: string; role: string | null }[];
  ownedOrganizations: { userId: string; orgId: string }[];
  sources: ApprovalSource[];
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
  account: ApprovalAccount | null;
  freeGrantPresent: boolean;
}

export interface ApprovalRow {
  orgId: string;
  organizationName: string | null;
  status: ApprovalStatus;
  reason: ApprovalReason;
  existingSource: boolean;
  source: Pick<
    ApprovalSource,
    | 'id'
    | 'identity'
    | 'platformType'
    | 'isActive'
    | 'billingPlanId'
    | 'billingStatus'
    | 'billingActivatedAt'
  > | null;
  account: (ApprovalAccount & { availableCredits: number }) | null;
  freeGrantPresent: boolean;
  proposed: {
    createSource: boolean;
    freeGrantQuantity: number;
    accountStatus: Extract<CreditAccountStatus, 'active'>;
    billingActivatedAt: string | null;
  } | null;
}

export interface ApprovalEvaluation {
  row: ApprovalRow;
  fingerprint: string;
}
export interface ApprovalCounts {
  eligible: number;
  alreadyApproved: number;
  skipped: number;
  existingSource: number;
  ambiguous: number;
}
export interface ApprovalPreviewEntry {
  orgId: string;
  fingerprint: string;
}
export interface ApprovalApplyResult {
  orgId: string;
  outcome:
    | 'approved'
    | 'already_applied'
    | 'unchanged'
    | 'skipped'
    | 'changed'
    | 'failed';
  reason: ApprovalReason | 'preview_changed' | 'approval_failed';
  integrationId?: string;
  auditId?: string;
  grantedCredits?: number;
}
