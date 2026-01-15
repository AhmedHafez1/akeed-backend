export type VerificationStatus =
  | 'pending'
  | 'sent'
  | 'delivered'
  | 'confirmed'
  | 'canceled'
  | 'expired'
  | 'failed';

export interface IVerification {
  id: string;
  orgId: string;
  orderId: string;
  status: VerificationStatus;
  waMessageId?: string;
  attempts: number;
}
