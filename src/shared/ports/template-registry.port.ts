import type {
  ImageTwinTemplate,
  RegistryTemplate,
} from '../messaging/template-registry.types';

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
   * The keys of templates retired for good. Only Settings asks, to leave a
   * retired template out of what it shows for a language that is not live.
   * Absent: none is known to be retired.
   */
  retiredTemplateKeys?(): Promise<readonly string[]>;
  /**
   * Whether a send may use only templates the provider has approved. Absent
   * means off: any active template is sent.
   */
  sendGuardrailEnabled?(): boolean;
  /**
   * The image-header twins, inactive ones included. Read only for a store
   * with the logo header on. Absent: no twin exists and text is sent.
   */
  listImageTwins?(): Promise<readonly ImageTwinTemplate[]>;
}
