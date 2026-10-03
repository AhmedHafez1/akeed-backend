import type { MessagingSenderStatus } from '../ports/messaging.port';
import type { CommerceOutcomeAction } from './commerce-outcome';

/**
 * What a connected source adds to setup and health (US-06-05). A spoke whose
 * connection has its own state (a store, credentials, setup inputs) registers
 * a contributor; onboarding and settings read it by platform type and never
 * branch on a provider name. Sources with nothing to add register none.
 */
export const SOURCE_SETUP_CONTRIBUTORS = Symbol('SOURCE_SETUP_CONTRIBUTORS');

/** Setup blockers only a connected source can have. Never renamed. */
export const SOURCE_SETUP_BLOCKED_REASONS = [
  'order_defaults_missing',
  'webhook_secrets_missing',
  'credentials_rejected',
  'source_disconnected',
] as const;
export type SourceSetupBlockedReason =
  (typeof SOURCE_SETUP_BLOCKED_REASONS)[number];

/**
 * The last answer the provider gave to Akeed's credentials, not a live check.
 * `store_inactive` is the provider's own state for the store, not a fault of
 * the credentials. `removed`: disconnected, so Akeed holds none.
 */
export type SourceCredentialStatus =
  | 'ok'
  | 'store_inactive'
  | 'rejected'
  | 'removed';

export type SourceConnectionState = 'connected' | 'disconnected';

export interface SourceSetupContribution {
  connectionState: SourceConnectionState;
  disconnectedAt: string | null;
  /** The provider's store reference; `verified` once its data proved it. */
  store: { reference: string | null; verified: boolean };
  orderDefaults: { currency: string | null; phoneCountry: string | null };
  blockedReasons: SourceSetupBlockedReason[];
  credentials: { status: SourceCredentialStatus };
  /** Inbound deliveries refused before anything was stored. */
  delivery: {
    secretsMissing: boolean;
    rejectedCount: number;
    lastRejectedAt: string | null;
  };
}

export interface SourceSetupContributor {
  readonly platformType: string;
  /** State, settings and health stay readable after a disconnect. */
  readonly readableWhenDisconnected: boolean;
  /** Null when the source has no connection of this kind to describe. */
  describe(source: {
    id: string;
    orgId: string;
  }): Promise<SourceSetupContribution | null>;
}

/** The setup block of the onboarding state, for a source with a contributor. */
export interface SourceSetupDto {
  connectionState: SourceConnectionState;
  disconnectedAt: string | null;
  store: { reference: string | null; verified: boolean };
  orderDefaults: { currency: string | null; phoneCountry: string | null };
  sender: MessagingSenderStatus;
  canComplete: boolean;
  /** Common setup reasons first, then the source's own. */
  blockedReasons: string[];
}

/**
 * A source's health as separate facts (US-06-05). There is no overall status
 * on purpose: each signal has its own cause and its own fix, and a store with
 * no recent events is not a broken one.
 */
export interface SourceHealthDto {
  integrationId: string;
  platformType: string;
  connectionState: SourceConnectionState;
  disconnectedAt: string | null;
  /** How far back the counts look. `lastAcceptedAt` and backlog do not. */
  windowDays: number;
  /** Null for a source that holds no provider credentials. */
  credentials: { status: SourceCredentialStatus } | null;
  /** `lastAcceptedAt` null means no event yet. It is never a fault. */
  events: { lastAcceptedAt: string | null; acceptedCount: number };
  processing: { failedCount: number; lastFailedAt: string | null };
  /** Accepted and waiting to be processed now. */
  backlog: { waitingCount: number; oldestWaitingAt: string | null };
  /** Outcomes the store did not take; the local decision is kept either way. */
  remoteSync: {
    failedCount: number;
    lastFailedAt: string | null;
    pendingCount: number;
    requiresAssistance: boolean;
  };
  delivery: SourceSetupContribution['delivery'] | null;
  /** What Akeed can write to this store right now, per outcome. */
  capabilities: { action: CommerceOutcomeAction; supported: boolean }[];
}

export const SOURCE_HEALTH_WINDOW_DAYS = 7;
