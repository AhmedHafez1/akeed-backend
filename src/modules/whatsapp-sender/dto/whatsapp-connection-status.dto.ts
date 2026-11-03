import type {
  WhatsappConnectionState,
  WhatsappSetupStatus,
  WhatsappSetupStep,
  WhatsappSignupPath,
  WhatsappTemplateDriftReason,
} from '../../../infrastructure/database/schema';

/**
 * A connection's setup and templates, for a member of the organization.
 * Named safe fields only: never a token, PIN, ciphertext or provider message.
 */
export interface WhatsappConnectionStatusDto {
  state: WhatsappConnectionState;
  signupPath: WhatsappSignupPath;
  displayPhoneNumber: string | null;
  setup: {
    /** `pending` or `running`: queued or in progress. `exhausted`: staff. */
    status: WhatsappSetupStatus;
    step: WhatsappSetupStep;
    /** A stable code for the last failure, such as `register_rejected`. */
    errorCode: string | null;
    /** When a failed setup is tried again. */
    retryAt: string | null;
    subscribedAt: string | null;
    numberVerifiedAt: string | null;
    registeredAt: string | null;
    completedAt: string | null;
  };
  templates: {
    total: number;
    /** Approved as UTILITY in the merchant's account. */
    ready: number;
    /** Waiting on Meta's review or on Akeed's submission. */
    pending: number;
    rejected: number;
    /** Approved under a category other than UTILITY. */
    recategorized: number;
    /** A submission failed and is tried again. */
    retrying: number;
    /** Out of retries, or text that cannot be copied. */
    needsStaff: number;
    /** Text differs from the registry; staff decide. */
    drift: number;
  };
}

/** The staff view adds Meta's ids and each template's outcome. */
export interface WhatsappConnectionStaffViewDto extends WhatsappConnectionStatusDto {
  wabaId: string;
  phoneNumberId: string;
  providerIsOnBizApp: boolean | null;
  providerPlatformType: string | null;
  setupAttempts: number;
  templateRows: {
    templateKey: string | null;
    templateName: string | null;
    languageCode: string;
    status: string;
    category: string | null;
    quality: string | null;
    rejectionReason: string | null;
    metaTemplateId: string | null;
    attempts: number;
    lastErrorCode: string | null;
    nextAttemptAt: string | null;
    submittedAt: string | null;
    lastSyncedAt: string | null;
    driftAt: string | null;
    driftReason: WhatsappTemplateDriftReason | null;
  }[];
}
