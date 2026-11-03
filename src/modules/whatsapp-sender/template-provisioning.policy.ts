import { createHash } from 'node:crypto';
import type { WhatsappConnectionTemplateRecord } from '../../infrastructure/database/repositories/whatsapp-connection-templates.repository';
import type { WhatsappConnectionTemplatePatch } from '../../infrastructure/database/repositories/whatsapp-connection-templates.repository';
import type { InspectedTemplate } from '../../infrastructure/database/repositories/whatsapp-templates.repository';
import type { OwnNumberGraphFailure } from '../../infrastructure/spokes/meta/own-number/own-number-graph.client';
import {
  RATE_LIMIT_ERROR_CODES,
  TOKEN_ERROR_CODE,
  isPermissionErrorCode,
  mapSubmissionErrorCode,
} from '../../infrastructure/spokes/meta/meta-template.mapping';
import {
  EXPECTED_CATEGORY_BY_PURPOSE,
  type ProviderTemplateRecord,
  type TemplateCategory,
  type TemplateComponentsSnapshot,
} from '../../shared/messaging/template-provider.types';
import {
  canonicalJson,
  hasTextDrift,
  templateIdentity,
} from '../template-registry/template-sync.rules';

/**
 * Akeed's own statuses for a template in a merchant's account. Once Meta has
 * listed a template, the row holds Meta's review status instead
 * (`approved`, `pending`, `rejected`, `paused`, ...), mapped to neutral terms.
 */
export const CONNECTION_TEMPLATE_STATUS = {
  /** Never sent. */
  notSubmitted: 'not_submitted',
  /** Claimed by a worker for one create request. */
  submitting: 'submitting',
  /** No usable answer: Meta may hold it. The next list decides. */
  unresolved: 'unresolved',
  /** The last create failed; retried at `next_attempt_at`. */
  failed: 'failed',
  /** Retries used up, or Meta refused the text itself. Staff look at it. */
  exhausted: 'exhausted',
  /** Its text cannot be copied as it is. Never sent. */
  incompatible: 'incompatible',
  /** Listed by Meta before, gone from its list now. Sent again. */
  missing: 'missing',
} as const;

const AKEED_STATUSES: ReadonlySet<string> = new Set(
  Object.values(CONNECTION_TEMPLATE_STATUS),
);

/** Template submissions get five tries, then wait for staff. */
export const TEMPLATE_MAX_ATTEMPTS = 5;
const TEMPLATE_RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  6 * 60 * 60_000,
];
/** A rate-limited create waits an hour before it is tried again. */
export const TEMPLATE_RATE_LIMIT_DELAY_MS = 60 * 60_000;

export function templateRetryDelayMs(attempts: number): number {
  const index = Math.min(
    Math.max(attempts, 1) - 1,
    TEMPLATE_RETRY_DELAYS_MS.length - 1,
  );
  return TEMPLATE_RETRY_DELAYS_MS[index];
}

/** Meta's code and subcode for "Content in This Language Already Exists". */
export const DUPLICATE_TEMPLATE_CODE = 100;
export const DUPLICATE_TEMPLATE_SUBCODE = 2388024;

/**
 * A registry template that belongs in every connected account: active, not
 * retired, approved for Akeed's own number, and with text a sync has read.
 * Image twins never reach this list: the registry read excludes them, and
 * own-number sends use the text template.
 */
export function isProvisionable(
  template: InspectedTemplate,
  retiredKeys: ReadonlySet<string>,
): boolean {
  return (
    template.template.isActive &&
    !retiredKeys.has(template.template.key) &&
    template.template.reviewStatus === 'approved' &&
    isReadable(template.components)
  );
}

/** The category a template is meant to have, by its purpose. */
export function intendedCategory(
  template: InspectedTemplate,
): TemplateCategory {
  return EXPECTED_CATEGORY_BY_PURPOSE[template.template.purpose];
}

/** SHA-256 of the text, with keys sorted so equal text hashes equal. */
export function componentsHash(snapshot: TemplateComponentsSnapshot): string {
  return createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
}

function isReadable(
  snapshot: TemplateComponentsSnapshot | null,
): snapshot is Exclude<TemplateComponentsSnapshot, { unknown: true }> {
  return snapshot !== null && !('unknown' in snapshot);
}

export type CreateFailureClass =
  /** The name and language exist: read the list and compare. */
  | { kind: 'duplicate' }
  | { kind: 'rate_limited'; errorCode: string }
  /** The token cannot manage templates: stop this account's run. */
  | { kind: 'credentials'; errorCode: string }
  /** Meta refused this text. Sending it again would be refused again. */
  | { kind: 'rejected'; errorCode: string }
  /** No usable answer: the template may exist. */
  | { kind: 'unresolved' };

export function classifyCreateFailure(
  failure: OwnNumberGraphFailure,
): CreateFailureClass {
  if (failure.kind !== 'rejected') return { kind: 'unresolved' };
  const code = failure.graphErrorCode;
  if (code === null) return { kind: 'unresolved' };
  if (
    code === DUPLICATE_TEMPLATE_CODE &&
    failure.graphErrorSubcode === DUPLICATE_TEMPLATE_SUBCODE
  )
    return { kind: 'duplicate' };
  if (RATE_LIMIT_ERROR_CODES.has(code))
    return { kind: 'rate_limited', errorCode: 'rate_limited' };
  if (code === TOKEN_ERROR_CODE || isPermissionErrorCode(code))
    return {
      kind: 'credentials',
      errorCode:
        code === TOKEN_ERROR_CODE ? 'auth_failed' : 'permission_denied',
    };
  return { kind: 'rejected', errorCode: mapSubmissionErrorCode(code) };
}

/** What one listed template says about the connection's row. */
export function providerPatch(
  record: ProviderTemplateRecord,
): WhatsappConnectionTemplatePatch {
  return {
    metaTemplateId: record.providerTemplateId,
    metaLanguageCode: record.languageCode,
    status: record.status,
    category: record.category,
    quality: record.quality,
    rejectionReason: record.rejectionReason ?? null,
    lastError: null,
    lastErrorCode: null,
    nextAttemptAt: null,
    leaseUntil: null,
    lastSyncedAt: 'now',
  };
}

/**
 * Drift for staff, never a resubmission. `registry_edited`: the registry text
 * is not what was submitted. `provider_differs`: Meta holds other text than
 * the registry. A row already marked keeps its first mark.
 */
export function driftOf(
  row: Pick<WhatsappConnectionTemplateRecord, 'submittedComponentsHash'>,
  registry: TemplateComponentsSnapshot | null,
  provider: TemplateComponentsSnapshot | null,
): 'registry_edited' | 'provider_differs' | null {
  if (
    isReadable(registry) &&
    row.submittedComponentsHash !== null &&
    componentsHash(registry) !== row.submittedComponentsHash
  )
    return 'registry_edited';
  if (hasTextDrift(registry, provider)) return 'provider_differs';
  return null;
}

export interface RowSyncPlan {
  row: WhatsappConnectionTemplateRecord;
  patch: WhatsappConnectionTemplatePatch | null;
}

/**
 * What a sync writes to each of a connection's rows. Meta's list is the
 * truth and a webhook only a hint (the runbook's rule):
 *
 * - A listed template takes Meta's id, status, category, quality and reason,
 *   and its drift is checked.
 * - A row Meta listed before and no longer lists is `missing`, and is sent
 *   again.
 * - A row left `submitting` past its lease, or `unresolved`, that Meta does
 *   not list was never created: it becomes `failed` and due now. One Meta
 *   lists was created, and simply takes Meta's values.
 * - Akeed's other states are left as they are.
 */
export function planRowSync(
  rows: readonly WhatsappConnectionTemplateRecord[],
  records: readonly ProviderTemplateRecord[],
  registryById: ReadonlyMap<string, InspectedTemplate>,
  now: Date,
): RowSyncPlan[] {
  const byIdentity = new Map<string, ProviderTemplateRecord>();
  for (const record of records)
    byIdentity.set(
      templateIdentity(record.templateName, record.languageCode),
      record,
    );
  return rows.map((row): RowSyncPlan => {
    const registry = registryById.get(row.templateId);
    if (!registry) return { row, patch: null };
    const record = byIdentity.get(
      templateIdentity(
        registry.template.templateName,
        registry.template.languageCode,
      ),
    );
    if (record) {
      const drift =
        row.driftAt === null
          ? driftOf(row, registry.components, record.components)
          : null;
      return {
        row,
        patch: {
          ...providerPatch(record),
          ...(drift && { driftAt: 'now', driftReason: drift }),
        },
      };
    }
    const leaseOver =
      row.leaseUntil === null || Date.parse(row.leaseUntil) <= now.getTime();
    if (
      row.status === CONNECTION_TEMPLATE_STATUS.unresolved ||
      (row.status === CONNECTION_TEMPLATE_STATUS.submitting && leaseOver)
    )
      return {
        row,
        patch: {
          status: CONNECTION_TEMPLATE_STATUS.failed,
          lastErrorCode: 'not_created',
          nextAttemptAt: now.toISOString(),
          leaseUntil: null,
          lastSyncedAt: 'now',
        },
      };
    if (!AKEED_STATUSES.has(row.status))
      return {
        row,
        patch: {
          status: CONNECTION_TEMPLATE_STATUS.missing,
          metaTemplateId: null,
          nextAttemptAt: null,
          lastSyncedAt: 'now',
        },
      };
    return { row, patch: null };
  });
}

/** A row the provisioner may still send: never sent, failed and due, gone. */
export function isSubmittable(
  row: Pick<WhatsappConnectionTemplateRecord, 'status' | 'nextAttemptAt'>,
  now: Date,
): boolean {
  if (
    row.status !== CONNECTION_TEMPLATE_STATUS.notSubmitted &&
    row.status !== CONNECTION_TEMPLATE_STATUS.failed &&
    row.status !== CONNECTION_TEMPLATE_STATUS.missing
  )
    return false;
  return (
    row.nextAttemptAt === null || Date.parse(row.nextAttemptAt) <= now.getTime()
  );
}

/**
 * Setup's provisioning is finished when no row waits on a submission or on
 * an answer: everything is at Meta, refused, incompatible or out of retries.
 */
export function provisioningSettled(
  rows: readonly Pick<WhatsappConnectionTemplateRecord, 'status'>[],
): boolean {
  return rows.every(
    (row) =>
      row.status !== CONNECTION_TEMPLATE_STATUS.notSubmitted &&
      row.status !== CONNECTION_TEMPLATE_STATUS.submitting &&
      row.status !== CONNECTION_TEMPLATE_STATUS.unresolved &&
      row.status !== CONNECTION_TEMPLATE_STATUS.failed &&
      row.status !== CONNECTION_TEMPLATE_STATUS.missing,
  );
}

/**
 * Counts for the status view. `ready` means approved and UTILITY in the
 * merchant's account; nothing else is ready, whatever Akeed submitted.
 */
export function summarizeTemplates(
  rows: readonly Pick<
    WhatsappConnectionTemplateRecord,
    'status' | 'category' | 'driftAt' | 'nextAttemptAt'
  >[],
) {
  const count = (test: (row: (typeof rows)[number]) => boolean) =>
    rows.filter(test).length;
  return {
    total: rows.length,
    ready: count(
      (row) => row.status === 'approved' && row.category === 'utility',
    ),
    pending: count(
      (row) =>
        row.status === 'pending' ||
        row.status === 'in_appeal' ||
        row.status === CONNECTION_TEMPLATE_STATUS.notSubmitted ||
        row.status === CONNECTION_TEMPLATE_STATUS.submitting ||
        row.status === CONNECTION_TEMPLATE_STATUS.unresolved ||
        row.status === CONNECTION_TEMPLATE_STATUS.missing,
    ),
    rejected: count((row) => row.status === 'rejected'),
    recategorized: count(
      (row) =>
        row.status === 'approved' &&
        row.category !== null &&
        row.category !== 'utility',
    ),
    retrying: count((row) => row.status === CONNECTION_TEMPLATE_STATUS.failed),
    needsStaff: count(
      (row) =>
        row.status === CONNECTION_TEMPLATE_STATUS.exhausted ||
        row.status === CONNECTION_TEMPLATE_STATUS.incompatible,
    ),
    drift: count((row) => row.driftAt !== null),
  };
}
