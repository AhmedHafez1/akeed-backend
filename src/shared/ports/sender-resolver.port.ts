import type { SelectedCodTemplate } from '../messaging/cod-template-selector';

export const SENDER_RESOLVER_PORT = Symbol('SENDER_RESOLVER_PORT');

/** Provider-neutral identity of the sender chosen for one logical message. */
export interface ResolvedSender {
  kind: 'akeed_system' | 'merchant_own';
  connectionId: string | null;
  reason: string;
  /** Current accounting charges one unit for either sender. */
  units: 1;
}

export interface SenderResolverPort {
  resolve(params: {
    orgId: string;
    template: SelectedCodTemplate;
  }): Promise<ResolvedSender>;
  /**
   * Which sender the organization's next send would most likely use, for
   * gates that price a send before a template is chosen: the merchant's
   * number when sending is on and the connection is active and healthy. The
   * template is not checked, so the claim still decides the real cost.
   */
  predict?(orgId: string): Promise<ResolvedSender['kind']>;
}

export const FEATURE_OFF_SENDER: ResolvedSender = {
  kind: 'akeed_system',
  connectionId: null,
  reason: 'feature_off',
  units: 1,
};
