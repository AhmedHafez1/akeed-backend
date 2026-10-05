import type { RegistryTemplate } from '../messaging/template-registry.types';

export const TEMPLATE_REGISTRY_PORT = Symbol('TEMPLATE_REGISTRY_PORT');

/**
 * Where the templates Akeed may send are defined. Callers get neutral rows
 * and decide with the pure rules in `shared/messaging/template-selector`.
 */
export interface TemplateRegistryPort {
  /**
   * Every template, inactive ones included, in display order. The result may
   * be a short-lived cached copy.
   */
  listTemplates(): Promise<readonly RegistryTemplate[]>;
  /** Drops any cached copy, so the next read sees a write just made. */
  invalidate(): void;
  /**
   * Whether a send may use only templates the provider has approved. Absent
   * means off, which is how every send behaved before US-08-04.
   */
  sendGuardrailEnabled?(): boolean;
}
