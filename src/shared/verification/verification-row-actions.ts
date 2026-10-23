import type { CommerceOutcomeAction } from '../commerce/commerce-outcome';
import { isRetryableVerificationReason } from './verification-lifecycle';
import type { VerificationStatus } from '../interfaces/verification.interface';

/**
 * Actions a merchant can take on a single verification row.
 *
 * The dashboard renders its row actions from this list rather than from the
 * runtime mode, so an action appears in the embedded and standalone tables
 * under exactly the same conditions. A new platform gains (or loses) an action
 * by reporting a different capability here — not by adding a branch in the UI.
 */
export type VerificationRowAction =
  | Extract<CommerceOutcomeAction, 'merchant_no_reply_cancellation'>
  | 'retry_verification'
  | 'merchant_manual_confirmation'
  | 'auto_cancel_exclusion';

export interface VerificationRowCapability {
  action: VerificationRowAction;
  supported: boolean;
}

/**
 * Whether a failed verification can be re-sent.
 *
 * Retry is offered only for failures whose cause the merchant can actually
 * clear — a topped-up plan, a reactivated source, settled billing. A permanent
 * defect stays un-retryable so the button does not promise something that will
 * fail again identically.
 */
export function canRetryVerification(
  status: VerificationStatus | null | undefined,
  reason: string | null | undefined,
): boolean {
  return status === 'failed' && isRetryableVerificationReason(reason);
}

/** Read the failure reason a send/dispatch path recorded on the verification. */
export function readVerificationReason(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const reason = (metadata as Record<string, unknown>).reason;
  return typeof reason === 'string' && reason.length > 0 ? reason : null;
}

/** Read the provider's error code for a delivery the provider reported failed. */
export function readProviderErrorCode(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const code = (metadata as Record<string, unknown>).providerErrorCode;
  if (typeof code === 'number' && Number.isFinite(code)) return String(code);
  return typeof code === 'string' && code.length > 0 ? code : null;
}

/** Read the provider's own title for that error code. */
export function readProviderErrorTitle(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const title = (metadata as Record<string, unknown>).providerErrorTitle;
  return typeof title === 'string' && title.length > 0 ? title : null;
}
