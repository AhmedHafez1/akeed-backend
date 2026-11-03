import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import type { WhatsappSignupPath } from '../../../infrastructure/database/schema';

/** The web app's languages; the connect page opens in the member's own. */
export const WHATSAPP_CONNECT_LOCALES = [
  'ar',
  'en',
  'ur',
  'es',
  'fr',
  'tr',
] as const;
export type WhatsappConnectLocale = (typeof WHATSAPP_CONNECT_LOCALES)[number];

/** The shape `generateInstallToken` writes: 32 random bytes, base64url. */
const TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const META_ID_PATTERN = /^\d{1,32}$/;

export class IssueWhatsappConnectTicketDto {
  @IsIn(WHATSAPP_CONNECT_LOCALES)
  locale!: WhatsappConnectLocale;
}

export class ClaimWhatsappConnectTicketDto {
  @IsString()
  @Matches(TICKET_PATTERN)
  ticket!: string;
}

/**
 * The login code and what the signup page reported. The ids are hints the
 * server checks against the token; they never grant access on their own.
 */
export class CompleteWhatsappSignupDto {
  @IsString()
  @Matches(TICKET_PATTERN)
  signupTicket!: string;

  /** Meta's login code: opaque, printable, short-lived. */
  @IsString()
  @MaxLength(2048)
  @Matches(/^[\x21-\x7e]+$/)
  code!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @Matches(META_ID_PATTERN, { each: true })
  wabaIds?: string[];

  @IsOptional()
  @IsString()
  @Matches(META_ID_PATTERN)
  phoneNumberId?: string;

  @IsOptional()
  @IsBoolean()
  isOnBusinessApp?: boolean;
}

export interface WhatsappConnectTicketIssuedDto {
  /**
   * The connect page link. It carries the ticket, so it is returned once to
   * the owner who asked, used for navigation and stored nowhere.
   */
  connectUrl: string;
  expiresAt: string;
}

/** What the connect page needs to launch Embedded Signup. */
export interface WhatsappConnectTicketClaimedDto {
  /** Single use, for the one completion request. Held in page memory only. */
  signupTicket: string;
  expiresAt: string;
  appId: string;
  configId: string;
  graphApiVersion: string;
}

/** A verified signup. Never a token, PIN, ticket or ciphertext. */
export interface WhatsappSignupCompletedDto {
  state: 'connecting';
  displayPhoneNumber: string | null;
  signupPath: WhatsappSignupPath;
}
