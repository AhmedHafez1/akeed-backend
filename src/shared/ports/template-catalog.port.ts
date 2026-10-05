import type { ProviderTemplateRecord } from '../messaging/template-provider.types';

export const TEMPLATE_CATALOG_PORT = Symbol('TEMPLATE_CATALOG_PORT');

/**
 * Read access to the templates the messaging provider holds for Akeed's one
 * sender. Records are neutral: the provider's statuses, categories, error
 * codes and component JSON never pass this port.
 */
export interface TemplateCatalogPort {
  /**
   * Every template of the sender's account, read in full before returning.
   * Throws `TemplateCatalogError` on any failure, so a caller never sees a
   * partial list.
   */
  listTemplates(): Promise<ProviderTemplateRecord[]>;
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
