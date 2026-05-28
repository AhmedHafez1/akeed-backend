import type { CodTemplateSelection } from '../messaging/cod-template-catalog';

export const MESSAGING_PORT = Symbol('MESSAGING_PORT');

export interface MessagingPort {
  sendVerificationTemplate(params: {
    to: string;
    orderNumber: string;
    totalPrice: string;
    verificationId: string;
    preferredLanguage?: string;
    templateSelection?: Partial<CodTemplateSelection>;
  }): Promise<{ messages?: Array<{ id: string }> }>;
}
