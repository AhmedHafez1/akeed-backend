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

/**
 * The two setup inputs the order payload does not carry (contract record
 * section 4). The service checks them against the supported values.
 */
export class SaveEasyOrdersOrderSettingsDto {
  @IsString()
  @TrimString()
  @Matches(/^[A-Za-z]{3}$/)
  currency!: string;

  @IsString()
  @TrimString()
  @Matches(/^[A-Za-z]{2}$/)
  phoneCountry!: string;
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
  | 'connected'
  /** Disconnected by an owner or admin; only the same store can reconnect. */
  | 'disconnected';

export type EasyOrdersConnectionHealth =
  | 'ok'
  | 'store_inactive'
  | 'credentials_rejected';

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
    /**
     * Last characters of the webhook URLs, to find them in EasyOrders. Null
     * once disconnected: the address is retired and answers nothing.
     */
    webhookUrlHint: string | null;
    ordersSecretSet: boolean;
    statusSecretSet: boolean;
    /** Store currency for every order; null until the merchant chooses it. */
    currency: string | null;
    /** Country local phone numbers are read in; null until chosen. */
    phoneCountry: string | null;
    /** Webhooks refused for a wrong secret since the connection was made. */
    rejectedDeliveries: number;
    connectedAt: string;
    /**
     * Set while the source is disconnected, including while a reconnect is
     * `pending`, `failed` or `expired`.
     */
    disconnectedAt: string | null;
  } | null;
}
