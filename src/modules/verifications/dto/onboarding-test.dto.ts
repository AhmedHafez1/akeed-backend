import { IsBoolean, IsOptional } from 'class-validator';
import type { CodTemplatePreview } from '../../../shared/messaging/cod-template-catalog';
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
  preview: CodTemplatePreview;
  sample: {
    customerName: string;
    orderNumber: string;
    total: string;
    currency: string;
    storeName: string;
  };
  test: OnboardingTestAttemptDto | null;
  resendAvailableAt: string | null;
  sendsRemainingToday: number;
  testConfirmedAt: string | null;
  testSkippedAt: string | null;
}
