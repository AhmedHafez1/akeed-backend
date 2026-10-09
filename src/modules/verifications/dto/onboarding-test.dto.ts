import { IsBoolean, IsOptional } from 'class-validator';
import type { TemplatePreview } from '../../../shared/messaging/template-registry.types';
import type { TemplateMessageLines } from '../../../shared/messaging/template-text.types';
import type { VerificationStatus } from '../../../shared/interfaces/verification.interface';

export class SendOnboardingTestDto {
  @IsOptional()
  @IsBoolean()
  resend?: boolean;
}

export interface OnboardingTestAttemptDto {
  verificationId: string;
  status: VerificationStatus;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  confirmedAt: string | null;
  canceledAt: string | null;
}

export interface OnboardingTestStatusDto {
  phone: string | null;
  language: 'ar' | 'en';
  preview: TemplatePreview;
  /** The test's message as neutral lines (US-08-07g). */
  message: TemplateMessageLines;
  sample: {
    customerName: string;
    orderNumber: string;
    total: string;
    currency: string;
    storeName: string;
  };
  test: OnboardingTestAttemptDto | null;
  resendAvailableAt: string | null;
  /**
   * The same cooldown as seconds from now, so the screen can count down on
   * its own clock whatever that clock says.
   */
  resendAvailableInSeconds: number;
  sendsRemainingToday: number;
  testConfirmedAt: string | null;
  testSkippedAt: string | null;
}
