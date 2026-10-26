import { createHash } from 'node:crypto';
import type { MetaConversionEvent } from '../../infrastructure/spokes/meta/meta-conversions.client';

/**
 * How long after an account is created its CompleteRegistration may still be
 * reported. The page reports it right after signup; anything later is a
 * replay, and refusing it keeps the public endpoint from minting
 * conversions for old accounts.
 */
export const COMPLETE_REGISTRATION_WINDOW_MS = 15 * 60_000;

export const COMPLETE_REGISTRATION_EVENT_NAME = 'CompleteRegistration';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Meta's email rule: trim and lowercase before hashing. */
export function normalizeEmailForMeta(email: string): string | undefined {
  const normalized = email.trim().toLowerCase();
  return normalized.includes('@') ? normalized : undefined;
}

export function isRecentSignup(
  createdAt: string | undefined,
  now: number,
): boolean {
  if (!createdAt) return false;
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return false;
  const age = now - created;
  // A little negative skew between Supabase's clock and ours is fine.
  return age >= -60_000 && age <= COMPLETE_REGISTRATION_WINDOW_MS;
}

export interface CompleteRegistrationInput {
  eventId: string;
  eventSourceUrl: string;
  userId: string;
  email?: string;
  clientIp?: string;
  userAgent?: string;
  fbp?: string;
  fbc?: string;
  now: number;
}

export function buildCompleteRegistrationEvent(
  input: CompleteRegistrationInput,
): MetaConversionEvent {
  const email = input.email ? normalizeEmailForMeta(input.email) : undefined;
  return {
    event_name: COMPLETE_REGISTRATION_EVENT_NAME,
    event_time: Math.floor(input.now / 1000),
    event_id: input.eventId,
    event_source_url: input.eventSourceUrl,
    action_source: 'website',
    user_data: {
      ...(email ? { em: [sha256Hex(email)] } : {}),
      external_id: [sha256Hex(input.userId)],
      ...(input.clientIp ? { client_ip_address: input.clientIp } : {}),
      ...(input.userAgent ? { client_user_agent: input.userAgent } : {}),
      ...(input.fbp ? { fbp: input.fbp } : {}),
      ...(input.fbc ? { fbc: input.fbc } : {}),
    },
  };
}
