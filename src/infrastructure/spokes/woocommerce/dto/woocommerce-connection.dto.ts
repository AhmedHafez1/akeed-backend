import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';
import type { SourceWebhookHealth } from '../../../../shared/commerce/source-setup';
import { TrimString } from '../../../../shared/validation/trim.transform';
import {
  WOOCOMMERCE_INSTALL_LOCALES,
  type WooCommerceInstallLocale,
} from '../woocommerce-install-link';

export class StartWooCommerceInstallDto {
  /**
   * The address as the merchant typed it. Only its shape is checked here;
   * the service canonicalizes it and answers with the store-URL codes.
   */
  @IsString()
  @TrimString()
  @MinLength(1)
  @MaxLength(2048)
  storeUrl!: string;

  /** Where the store sends the merchant back to: the app in their language. */
  @IsIn(WOOCOMMERCE_INSTALL_LOCALES)
  locale!: WooCommerceInstallLocale;
}

export interface WooCommerceInstallStartedDto {
  /**
   * The store's authorize link. It carries the install's callback token, so
   * it is returned once to the member who started the install, used for
   * navigation and stored nowhere.
   */
  authorizeUrl: string;
  /** The canonical store URL the install is bound to. */
  storeUrl: string;
  expiresAt: string;
}

export type WooCommerceConnectionState =
  | 'unavailable'
  | 'pilot_required'
  | 'source_exists'
  | 'ready'
  | 'pending'
  | 'failed'
  | 'expired'
  | 'connected'
  /** Disconnected by an owner or admin; only the same store can reconnect. */
  | 'disconnected';

export type WooCommerceConnectionHealth =
  | 'ok'
  | 'credentials_rejected'
  | 'permission_denied';

/**
 * Each webhook as the store last answered. `unknown` until the store has
 * been asked, or when its last answer named no state.
 */
export type WooCommerceWebhookStatesDto = SourceWebhookHealth['items'];

/** Never carries a key, a secret, a token, a link or the install reference. */
export interface WooCommerceConnectionStatusDto {
  state: WooCommerceConnectionState;
  canManage: boolean;
  organizationName: string | null;
  /**
   * The canonical URL of the store that is connected, or that the open or
   * last install was for.
   */
  storeUrl: string | null;
  /** The open install context's deadline, while `state` is `pending`. */
  expiresAt: string | null;
  /** Why the last install attempt was refused, while `state` is `failed`. */
  lastErrorCode: string | null;
  connection: {
    storeUrl: string;
    health: WooCommerceConnectionHealth;
    connectedAt: string;
    /** Deliveries refused for a wrong signature or source address. */
    rejectedDeliveries: number;
    /** The last states read from the store; empty once disconnected. */
    webhooks: WooCommerceWebhookStatesDto;
    /** When the store was last asked; nothing asks it in the background. */
    webhooksCheckedAt: string | null;
    /** Set while disconnected, including while a reconnect is under way. */
    disconnectedAt: string | null;
  } | null;
}

/**
 * Whether Akeed's webhooks were deleted at the store. `failed`: the store
 * could not be asked or refused, so they are still there and answer 401.
 * `not_attempted`: the source was already disconnected.
 */
export type WooCommerceWebhookCleanup = 'removed' | 'failed' | 'not_attempted';

export interface WooCommerceDisconnectedDto extends WooCommerceConnectionStatusDto {
  webhookCleanup: WooCommerceWebhookCleanup;
}

/** A diagnosis, answered 200 whatever it found. */
export interface WooCommerceConnectionCheckDto {
  checkedAt: string;
  /** Codes, most fundamental first. Empty when nothing is wrong. */
  problems: string[];
  /** As the store answered just now; `unknown` where it could not be asked. */
  webhooks: WooCommerceWebhookStatesDto;
  status: WooCommerceConnectionStatusDto;
}
