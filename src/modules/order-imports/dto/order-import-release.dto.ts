import { IsOptional, IsString, MaxLength } from 'class-validator';
import type { UsageAccountingMode } from '../../../shared/billing/entitlement';
import type { ImportStartBlocker } from '../release/import-blockers';

/**
 * `POST /api/order-imports/:id/start` body (AC3). Both fields are optional
 * here on purpose: a missing attestation answers IMPORT_ATTESTATION_REQUIRED
 * and a missing quote IMPORT_QUOTE_STALE with a fresh quote, which tell the
 * client what to do, rather than a generic validation failure.
 */
export class StartOrderImportDto {
  @IsOptional()
  @IsString({ message: 'attestationVersion must be a string.' })
  @MaxLength(64, { message: 'attestationVersion is too long.' })
  attestationVersion?: string;

  @IsOptional()
  @IsString({ message: 'quoteToken must be a string.' })
  @MaxLength(1024, { message: 'quoteToken is too long.' })
  quoteToken?: string;
}

/** `GET /api/order-imports/:id/start-quote` (AC1). */
export interface OrderImportStartQuoteDto {
  batchId: string;
  /** Held orders that would be released: N. */
  orders: number;
  accountingMode: UsageAccountingMode;
  /** Prepaid-credit sources. */
  creditsAvailable: number | null;
  /** Periodic-plan sources. */
  slotsRemaining: number | null;
  estimatedCreditsMin: number;
  estimatedCreditsMax: number;
  ratePerMinute: number;
  estimatedDurationMinutes: number;
  quietHours: {
    enabled: boolean;
    start: string | null;
    end: string | null;
    timezone: string;
  };
  startDeadlineAt: string | null;
  blockers: ImportStartBlocker[];
  quoteToken: string;
  quoteExpiresAt: string;
  attestation: { version: string; text: { en: string; ar: string } };
}

/** `POST /api/order-imports/:id/stop` (AC8). */
export interface OrderImportStopResponseDto {
  batchId: string;
  status: 'stopped';
  released: number;
  withdrawn: number;
}

/** Release progress on `GET /:id` once a batch is committed (AC12). */
export interface OrderImportReleaseStateDto {
  committedAt: string | null;
  startDeadlineAt: string | null;
  startedAt: string | null;
  pausedReason: string | null;
  quietHoursUntil: string | null;
  stoppedAt: string | null;
  completedAt: string | null;
  ratePerMinute: number;
  storeTimezone: string | null;
  release: { total: number; held: number; released: number; withdrawn: number };
  lifecycle: {
    queued: number;
    sent: number;
    confirmed: number;
    canceled: number;
    noReply: number;
    failed: number;
  };
}
