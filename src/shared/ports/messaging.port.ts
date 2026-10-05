import type {
  SelectedCodTemplate,
  SentTemplateIdentity,
} from '../messaging/cod-template-selector';

export const MESSAGING_PORT = Symbol('MESSAGING_PORT');

/**
 * Whether this deployment holds the shared Akeed sender's credentials. It is
 * read from configuration: no provider call, and no claim about delivery,
 * template approval or number quality.
 */
export interface MessagingSenderStatus {
  sender: 'akeed_shared';
  status: 'configured' | 'not_configured' | 'unknown';
}

export interface MessagingPort {
  /** Optional: an adapter that cannot tell is reported as `unknown`. */
  getSenderStatus?(): MessagingSenderStatus;
  sendVerificationTemplate(params: {
    to: string;
    customerName?: string | null;
    storeName?: string | null;
    orderNumber: string;
    totalPrice: string;
    verificationId: string;
    /** Selected before the dispatch was claimed; the adapter sends this one. */
    template: SelectedCodTemplate;
  }): Promise<{
    messages?: Array<{ id: string }>;
    /** What the adapter sent. Absent when an adapter does not report it. */
    template?: SentTemplateIdentity;
  }>;
}

export class ConfirmedMessageRejection extends Error {
  constructor(readonly code: string) {
    super('The messaging provider confirmed rejection.');
  }
}
