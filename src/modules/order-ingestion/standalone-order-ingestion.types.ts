import type {
  CanonicalOrderInput,
  StandaloneIngestionChannel,
} from '../../shared/commerce/standalone-order-envelope';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import type { StandaloneReadinessCodeMap } from './standalone-readiness-gate';
import type { StandaloneIntegrationSourceCodeMap } from './standalone-source-resolver';

export type {
  CanonicalOrderExtras,
  CanonicalOrderInput,
  StandaloneIngestionChannel,
} from '../../shared/commerce/standalone-order-envelope';

/** The trusted, already-resolved Standalone source an order is accepted into. */
export interface StandaloneIngestionContext {
  orgId: string;
  source: { id: string; platformStoreUrl: string };
}

export interface AcceptOneOptions {
  channel: StandaloneIngestionChannel;
  /** Channel-local key; the service namespaces it per channel. */
  idempotencyKey: string;
  /**
   * Accept without dispatching. The event stays invisible to every dispatch
   * path until it is released; `groupId` is the batch it belongs to.
   */
  hold?: { groupId: string };
  /** Channel metadata stored beside the order in `rawPayload`. */
  envelopeExtras?: Record<string, unknown>;
}

/**
 * A caller authenticated by an integration credential instead of a session.
 * `keyId` and `prefix` are log metadata; only `orgId` and `integrationId`
 * decide which source the order is accepted into.
 */
export interface IntegrationIngestionPrincipal {
  orgId: string;
  integrationId: string;
  keyId: string;
  prefix: string;
}

/** Who is submitting one order: a signed-in member or an integration. */
export type StandaloneIngestionPrincipal =
  | AuthenticatedUser
  | IntegrationIngestionPrincipal;

/**
 * `submitOne` never holds: a held acceptance sends nothing, so it has no
 * readiness to check and stays on `acceptOne` / `acceptMany`.
 */
export interface SubmitOneOptions<
  SourceCodes extends StandaloneIntegrationSourceCodeMap,
> extends Omit<AcceptOneOptions, 'hold'> {
  /** The channel's vocabulary for a refused source or an unready one. */
  codes: { source: SourceCodes; readiness: StandaloneReadinessCodeMap };
}

export interface AcceptOneResult {
  orderId: string;
  eventId: string;
  verificationId?: string;
  duplicate: boolean;
  held: boolean;
}

/** One row of a batch acceptance, already translated by a channel adapter. */
export interface AcceptManyInput {
  /** Channel-local key; the service namespaces it per channel. */
  idempotencyKey: string;
  order: CanonicalOrderInput;
  /** Channel metadata stored beside the order in `rawPayload`. */
  envelopeExtras?: Record<string, unknown>;
}

/**
 * `hold` is required, not optional: a batch acceptance never dispatches, so
 * the type makes invariant 1 (nothing is sent before `POST /start`)
 * structural rather than a convention a future caller could forget.
 */
export interface AcceptManyOptions {
  channel: StandaloneIngestionChannel;
  hold: { groupId: string };
}

/**
 * Per-row outcome, in input order. `already_imported` means another batch or
 * an earlier order already owned this external identity; nothing was written
 * for that row.
 */
export type AcceptManyRowResult =
  | { status: 'accepted'; orderId: string; eventId: string; duplicate: boolean }
  | { status: 'already_imported' };
