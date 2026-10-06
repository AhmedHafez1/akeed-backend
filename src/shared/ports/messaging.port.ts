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
    /**
     * Words for a missing customer or store name, in the template's language
     * (US-08-07e). Absent: the adapter keeps its own words, as before.
     */
    fallbacks?: { customer?: string; store?: string };
  }): Promise<{
    messages?: Array<{ id: string }>;
    /** What the adapter sent. Absent when an adapter does not report it. */
    template?: SentTemplateIdentity;
  }>;
  /**
   * A plain text inside the customer service window. Optional: an adapter
   * without it sends no acknowledgment or nudge. Never throws.
   */
  sendFreeFormText?(params: {
    to: string;
    body: string;
    /** For logs only. */
    verificationId: string;
  }): Promise<FreeFormTextOutcome>;
}

/**
 * What became of a free-form text (US-08-07 b, c). Sent once and never
 * retried (contract record, worst-case rule for 4.10.8).
 *
 * - `accepted`: the provider took it and gave its message id.
 * - `window_closed`: the customer service window had closed (record
 *   4.10.3). Expected, not a failure.
 * - `rejected`: the provider refused it for another reason.
 * - `failed`: no clear answer. It may or may not have been sent.
 */
export type FreeFormTextOutcome =
  | { outcome: 'accepted'; providerMessageId: string }
  | { outcome: 'window_closed' }
  | { outcome: 'rejected'; code: string }
  | { outcome: 'failed'; code: string };

export class ConfirmedMessageRejection extends Error {
  constructor(readonly code: string) {
    super('The messaging provider confirmed rejection.');
  }
}
