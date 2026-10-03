import { IsIn, IsString, Matches } from 'class-validator';
import { TrimString } from '../../../../shared/validation/trim.transform';
import {
  EASYORDERS_INSTALL_LOCALES,
  type EasyOrdersInstallLocale,
} from '../easyorders-install-link';

export class StartEasyOrdersInstallDto {
  /** Where EasyOrders sends the seller back to: the app in their language. */
  @IsIn(EASYORDERS_INSTALL_LOCALES)
  locale!: EasyOrdersInstallLocale;
}

/** Printable ASCII without spaces; EasyOrders secrets are 16 base64 characters. */
const WEBHOOK_SECRET_PATTERN = /^[\x21-\x7E]{8,128}$/;

export class SaveEasyOrdersWebhookSecretsDto {
  @IsString()
  @TrimString()
  @Matches(WEBHOOK_SECRET_PATTERN)
  ordersSecret!: string;

  @IsString()
  @TrimString()
  @Matches(WEBHOOK_SECRET_PATTERN)
  statusSecret!: string;
}

export interface EasyOrdersInstallStartedDto {
  /**
   * The authorized-app link. It carries the install's tokens, so it is
   * returned once to the member who started the install and stored nowhere.
   */
  installUrl: string;
  expiresAt: string;
}

export type EasyOrdersConnectionState =
  | 'unavailable'
  | 'pilot_required'
  | 'source_exists'
  | 'ready'
  | 'pending'
  | 'failed'
  | 'expired'
  | 'connected';

export type EasyOrdersConnectionHealth = 'ok' | 'store_inactive';

export interface EasyOrdersConnectionStatusDto {
  state: EasyOrdersConnectionState;
  canManage: boolean;
  /** The Akeed store the EasyOrders store is, or will be, connected to. */
  organizationName: string | null;
  /** The open install context's deadline, while `state` is `pending`. */
  expiresAt: string | null;
  /** Why the last install attempt was refused, while `state` is `failed`. */
  lastErrorCode: string | null;
  connection: {
    storeId: string;
    /** False until data fetched with the key carries the same store id. */
    storeVerified: boolean;
    health: EasyOrdersConnectionHealth;
    /** Last characters of the webhook URLs, to find them in EasyOrders. */
    webhookUrlHint: string;
    ordersSecretSet: boolean;
    statusSecretSet: boolean;
    connectedAt: string;
  } | null;
}
