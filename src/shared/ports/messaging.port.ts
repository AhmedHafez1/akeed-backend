import type { CodTemplateSelection } from '../messaging/cod-template-catalog';

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
    preferredLanguage?: string;
    templateSelection?: Partial<CodTemplateSelection>;
  }): Promise<{ messages?: Array<{ id: string }> }>;
}

export class ConfirmedMessageRejection extends Error {
  constructor(readonly code: string) {
    super('The messaging provider confirmed rejection.');
  }
}
