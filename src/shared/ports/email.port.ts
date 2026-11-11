export const EMAIL_PORT = Symbol('EMAIL_PORT');

export interface EmailMessage {
  /** Snapshotted for durable notifications so retries keep the same envelope. */
  from?: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Lets the provider drop a repeat of the same message. */
  idempotencyKey?: string;
}

/**
 * - `sent`: the provider accepted the message.
 * - `skipped`: email is switched off; nothing left the app.
 * - `failed`: the provider refused it or could not be reached. `reason` is a
 *   short code for the logs, never the provider's body.
 */
export type EmailSendResult =
  | { status: 'sent' }
  | { status: 'skipped'; reason: string }
  | {
      status: 'failed';
      reason: string;
      retryable?: boolean;
      uncertain?: boolean;
    };

/** Transactional email to a merchant. Never throws. */
export interface EmailPort {
  send(message: EmailMessage): Promise<EmailSendResult>;
}
