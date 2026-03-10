export const MESSAGING_PORT = Symbol('MESSAGING_PORT');

export interface MessagingPort {
  sendVerificationTemplate(
    to: string,
    orderNumber: string,
    totalPrice: string,
    verificationId: string,
    preferredLanguage?: string,
  ): Promise<{ messages?: Array<{ id: string }> }>;
}
