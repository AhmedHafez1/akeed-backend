import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { MetaConversionsClient } from '../../infrastructure/spokes/meta/meta-conversions.client';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import type { CompleteRegistrationDto } from './dto/complete-registration.dto';
import {
  buildCompleteRegistrationEvent,
  COMPLETE_REGISTRATION_WINDOW_MS,
  isRecentSignup,
} from './marketing-events.policy';

export interface MarketingRequestContext {
  clientIp?: string;
  userAgent?: string;
}

export type CompleteRegistrationOutcome =
  | 'sent'
  | 'disabled'
  | 'failed'
  | 'unknown_user'
  | 'stale_user'
  | 'duplicate';

/** Reads the account a signup page names, with the service role. */
export interface AccountLookup {
  getUserById(
    userId: string,
  ): Promise<{ email?: string; createdAt?: string } | null>;
}

export const MARKETING_ACCOUNT_LOOKUP = Symbol('MARKETING_ACCOUNT_LOOKUP');

/**
 * Server-side ad conversions that the browser Pixel also reports. The signup
 * page cannot be trusted, so the account it names is looked up with the
 * service role: it must exist and be minutes old, and its email comes from
 * Supabase, not from the request.
 *
 * Each account is reported once per process. That is enough here: the window
 * is short, the route is throttled, and Meta also drops a second server event
 * with the same event ID.
 */
@Injectable()
export class MarketingEventsService {
  private readonly logger = new Logger(MarketingEventsService.name);
  /** userId -> when its claim expires. */
  private readonly reported = new Map<string, number>();

  constructor(
    private readonly conversions: MetaConversionsClient,
    @Inject(MARKETING_ACCOUNT_LOOKUP)
    private readonly accounts: AccountLookup,
  ) {}

  /**
   * Starts the report and returns at once; the signup page never waits on
   * Meta, and no failure here reaches it.
   */
  acceptCompleteRegistration(
    dto: CompleteRegistrationDto,
    context: MarketingRequestContext,
  ): void {
    void this.reportCompleteRegistration(dto, context);
  }

  async reportCompleteRegistration(
    dto: CompleteRegistrationDto,
    context: MarketingRequestContext,
    now: number = Date.now(),
  ): Promise<CompleteRegistrationOutcome> {
    const outcome = await this.tryReport(dto, context, now).catch(
      (error: unknown) => {
        this.logger.warn(
          buildBackendLog(MarketingEventsService.name, {
            action: 'complete_registration_report',
            outcome: 'failure',
            eventId: dto.eventId,
            ...normalizeError(error),
          }),
        );
        return 'failed' as const;
      },
    );
    if (outcome !== 'sent' && outcome !== 'failed') {
      this.logger.log(
        buildBackendLog(MarketingEventsService.name, {
          action: 'complete_registration_report',
          outcome: 'skipped',
          reason: outcome,
          eventId: dto.eventId,
        }),
      );
    }
    return outcome;
  }

  private async tryReport(
    dto: CompleteRegistrationDto,
    context: MarketingRequestContext,
    now: number,
  ): Promise<CompleteRegistrationOutcome> {
    if (!this.conversions.isEnabled()) return 'disabled';

    const account = await this.accounts.getUserById(dto.userId);
    if (!account) return 'unknown_user';
    if (!isRecentSignup(account.createdAt, now)) return 'stale_user';
    if (!this.claim(dto.userId, now)) return 'duplicate';

    const event = buildCompleteRegistrationEvent({
      eventId: dto.eventId,
      eventSourceUrl: dto.eventSourceUrl,
      userId: dto.userId,
      email: account.email,
      clientIp: context.clientIp,
      userAgent: context.userAgent,
      fbp: dto.fbp,
      fbc: dto.fbc,
      now,
    });
    return this.conversions.send(event);
  }

  /** Synchronous, so two concurrent requests for one account cannot both pass. */
  private claim(userId: string, now: number): boolean {
    for (const [id, expiresAt] of this.reported) {
      if (expiresAt <= now) this.reported.delete(id);
    }
    if (this.reported.has(userId)) return false;
    this.reported.set(userId, now + COMPLETE_REGISTRATION_WINDOW_MS);
    return true;
  }
}

export function supabaseAccountLookup(config: ConfigService): AccountLookup {
  let client: SupabaseClient | undefined;
  return {
    async getUserById(userId) {
      client ??= createClient(
        config.getOrThrow<string>('SUPABASE_URL'),
        config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY'),
        { auth: { autoRefreshToken: false, persistSession: false } },
      );
      const { data, error } = await client.auth.admin.getUserById(userId);
      if (error || !data.user) return null;
      return { email: data.user.email, createdAt: data.user.created_at };
    },
  };
}
