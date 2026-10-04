import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';
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
  | 'connected';

export type WooCommerceConnectionHealth =
  | 'ok'
  | 'credentials_rejected'
  | 'permission_denied';

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
  } | null;
}
