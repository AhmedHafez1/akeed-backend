export type SenderFailureClass =
  | 'recipient'
  | 'retryable'
  | 'credentials'
  | 'payment'
  | 'restricted'
  | 'template'
  | 'payload'
  | 'unknown'
  | 'outcome_unknown';
export interface SenderFailure {
  class: SenderFailureClass;
  code: string | null;
  action: 'fail' | 'retry' | 'fallback';
  degrade: 'credentials' | 'payment' | 'restricted' | null;
  templateStatus?: string;
}
export class MerchantMessageFailure extends Error {
  get code(): string {
    return this.failure.code ?? 'outcome_unknown';
  }
  constructor(readonly failure: SenderFailure) {
    super('Merchant messaging attempt failed');
  }
}
export const UNKNOWN_SENDER_OUTCOME: SenderFailure = {
  class: 'outcome_unknown',
  code: null,
  action: 'fallback',
  degrade: null,
};
export interface MerchantAttemptContext {
  attemptId: string;
  claimToken: string;
}
export interface SenderRecoveryWork {
  dispatchId: string;
  orgId: string;
  verificationId: string;
  action: 'retry' | 'fallback';
  dueAt: string;
  version: number;
}
export const SENDER_HEALTH_PORT = Symbol('SENDER_HEALTH_PORT');
export interface SenderHealthResult {
  status: 'AVAILABLE' | 'LIMITED' | 'BLOCKED' | 'unknown';
  failure?: SenderFailure;
  qualityRating?: string | null;
  nameStatus?: string | null;
}
export interface SenderHealthPort {
  check(input: {
    orgId: string;
    connectionId: string;
    signupGeneration: number;
  }): Promise<SenderHealthResult>;
}
export const SENDER_EVENT_PORT = Symbol('SENDER_EVENT_PORT');
export interface SenderEvent {
  orgId: string;
  connectionId: string;
  kind: 'activated' | 'degraded' | 'recovered' | 'template_failed';
  dedupeKey: string;
  failureClass?: SenderFailureClass;
}
export interface SenderEventPort {
  emit(event: SenderEvent): Promise<void>;
}
