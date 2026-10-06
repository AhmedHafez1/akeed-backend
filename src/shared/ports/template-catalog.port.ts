import type {
  ProviderTemplateRecord,
  TemplateComponentsSnapshot,
} from '../messaging/template-provider.types';
import type { TemplateTextModel } from '../messaging/template-text.types';
import type {
  TemplateEditSubmission,
  TemplateSubmission,
  TemplateSubmissionResult,
} from '../messaging/template-draft.types';

export const TEMPLATE_CATALOG_PORT = Symbol('TEMPLATE_CATALOG_PORT');

/**
 * The templates the messaging provider holds for Akeed's one sender: reading
 * them, creating one and editing one. Records are neutral: the provider's
 * statuses, categories, error codes and component JSON never pass this port.
 * There is no delete: a template is retired in Akeed only (US-08-06).
 */
export interface TemplateCatalogPort {
  /**
   * Every template of the sender's account, read in full before returning.
   * Throws `TemplateCatalogError` on any failure, so a caller never sees a
   * partial list.
   */
  listTemplates(): Promise<ProviderTemplateRecord[]>;
  /**
   * Reads a synced snapshot's text into segments, so callers never parse the
   * provider's placeholder syntax. NULL when there is no snapshot or it could
   * not be read. Pure: no provider call.
   */
  describeComponents(
    snapshot: TemplateComponentsSnapshot | null,
  ): TemplateTextModel | null;
  /**
   * Creates a template at the provider and returns its ID and first review
   * status. Sent once and never retried: a `TemplateSubmissionError` whose
   * `ambiguous` is true means the provider may or may not hold the template,
   * and the caller must read `listTemplates()` before it sends anything again.
   */
  createTemplate(
    submission: TemplateSubmission,
  ): Promise<TemplateSubmissionResult>;
  /**
   * Replaces the text of an existing template. Sent once and never retried,
   * like `createTemplate`. The provider reviews the template again.
   */
  editTemplate(
    providerTemplateId: string,
    submission: TemplateEditSubmission,
  ): Promise<void>;
}

/**
 * Why the provider's templates could not be read.
 *
 * - `not_configured`: the account ID or token is missing.
 * - `auth_failed`: the token was refused.
 * - `permission_denied`: the token cannot manage templates. This is a
 *   credentials problem, not a template problem.
 * - `rate_limited`: the provider asked Akeed to slow down. The sync stops
 *   and waits for its next run; it never loops.
 * - `provider_error`: any other answer from the provider.
 * - `network`: no answer at all.
 * - `too_many_pages`: more pages than any account can hold.
 */
export type TemplateCatalogErrorCode =
  | 'not_configured'
  | 'auth_failed'
  | 'permission_denied'
  | 'rate_limited'
  | 'provider_error'
  | 'network'
  | 'too_many_pages';

export class TemplateCatalogError extends Error {
  constructor(
    readonly code: TemplateCatalogErrorCode,
    /** The provider's numeric code or HTTP status, for logs only. */
    readonly providerCode?: number,
  ) {
    super(`Template catalog read failed: ${code}`);
    this.name = 'TemplateCatalogError';
  }
}

/**
 * Why the provider did not accept a create or an edit.
 *
 * - `not_configured`, `auth_failed`, `permission_denied`, `rate_limited`:
 *   as for a read. None of them is a problem with the template.
 * - `invalid_parameter`, `character_limit`, `format_rejected`,
 *   `parameter_ratio`, `parameter_at_edge`: the provider refused the text.
 * - `integrity_blocked`: the provider's integrity checks blocked it.
 * - `status_locked`: the template's status does not allow the change.
 * - `provider_error`: a refusal with a code Akeed does not know.
 * - `unresolved`: no usable answer. The request may have been applied.
 */
export type TemplateSubmissionErrorCode =
  | 'not_configured'
  | 'auth_failed'
  | 'permission_denied'
  | 'rate_limited'
  | 'invalid_parameter'
  | 'character_limit'
  | 'format_rejected'
  | 'parameter_ratio'
  | 'parameter_at_edge'
  | 'integrity_blocked'
  | 'status_locked'
  | 'provider_error'
  | 'unresolved';

export class TemplateSubmissionError extends Error {
  constructor(
    readonly code: TemplateSubmissionErrorCode,
    /** True when the provider may have applied the request. */
    readonly ambiguous: boolean,
    /** The provider's numeric code or HTTP status, for logs and audit only. */
    readonly providerCode?: number,
    /** The provider's trace reference for the request, when it gave one. */
    readonly providerReference?: string,
  ) {
    super(`Template submission failed: ${code}`);
    this.name = 'TemplateSubmissionError';
  }
}
