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
}

export const FEATURE_OFF_SENDER: ResolvedSender = {
  kind: 'akeed_system',
  connectionId: null,
  reason: 'feature_off',
  units: 1,
};
