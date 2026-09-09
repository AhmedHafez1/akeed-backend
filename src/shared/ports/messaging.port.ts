import type { CodTemplateSelection } from '../messaging/cod-template-catalog';

export const MESSAGING_PORT = Symbol('MESSAGING_PORT');

export interface MessagingPort {
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
