import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * The codes connecting a merchant's own number answers with. The frontend
 * translates by code, so these are never renamed.
 */
export type WhatsappConnectErrorCode =
  | 'WHATSAPP_CONNECT_INVALID_REQUEST'
  | 'WHATSAPP_CONNECT_UNAVAILABLE'
  | 'WHATSAPP_CONNECT_TICKET_INVALID'
  | 'WHATSAPP_CONNECTION_OWNER_REQUIRED'
  | 'WHATSAPP_CONNECTION_EXISTS'
  | 'WHATSAPP_NUMBER_ALREADY_CONNECTED'
  | 'WHATSAPP_SIGNUP_CODE_REJECTED'
  | 'WHATSAPP_SIGNUP_PROVIDER_UNAVAILABLE'
  | 'WHATSAPP_SIGNUP_TOKEN_UNVERIFIED'
  | 'WHATSAPP_SIGNUP_ASSET_UNVERIFIED'
  | 'WHATSAPP_SIGNUP_ASSET_AMBIGUOUS';

const STATUS: Record<WhatsappConnectErrorCode, HttpStatus> = {
  WHATSAPP_CONNECT_INVALID_REQUEST: HttpStatus.BAD_REQUEST,
  WHATSAPP_CONNECT_UNAVAILABLE: HttpStatus.NOT_FOUND,
  WHATSAPP_CONNECT_TICKET_INVALID: HttpStatus.UNAUTHORIZED,
  WHATSAPP_CONNECTION_OWNER_REQUIRED: HttpStatus.FORBIDDEN,
  WHATSAPP_CONNECTION_EXISTS: HttpStatus.CONFLICT,
  WHATSAPP_NUMBER_ALREADY_CONNECTED: HttpStatus.CONFLICT,
  WHATSAPP_SIGNUP_CODE_REJECTED: HttpStatus.UNPROCESSABLE_ENTITY,
  WHATSAPP_SIGNUP_PROVIDER_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  WHATSAPP_SIGNUP_TOKEN_UNVERIFIED: HttpStatus.UNPROCESSABLE_ENTITY,
  WHATSAPP_SIGNUP_ASSET_UNVERIFIED: HttpStatus.UNPROCESSABLE_ENTITY,
  WHATSAPP_SIGNUP_ASSET_AMBIGUOUS: HttpStatus.UNPROCESSABLE_ENTITY,
};

const MESSAGES: Record<WhatsappConnectErrorCode, string> = {
  WHATSAPP_CONNECT_INVALID_REQUEST: 'The connection request is invalid.',
  WHATSAPP_CONNECT_UNAVAILABLE:
    'Connecting your own WhatsApp number is not available.',
  // One answer for an unknown, expired, used or replaced link: it never says
  // which.
  WHATSAPP_CONNECT_TICKET_INVALID:
    'This connection link is not valid. Start again from Akeed settings.',
  WHATSAPP_CONNECTION_OWNER_REQUIRED:
    'Owner role is required to change the WhatsApp connection',
  WHATSAPP_CONNECTION_EXISTS:
    'This organization already has a WhatsApp number connected or being set up.',
  WHATSAPP_NUMBER_ALREADY_CONNECTED:
    'This WhatsApp number is already connected to another Akeed account.',
  WHATSAPP_SIGNUP_CODE_REJECTED:
    'Meta did not accept the sign-in. Start again from Akeed settings.',
  WHATSAPP_SIGNUP_PROVIDER_UNAVAILABLE:
    'Meta did not answer in time. Start again from Akeed settings.',
  WHATSAPP_SIGNUP_TOKEN_UNVERIFIED:
    'Meta did not grant Akeed the WhatsApp permissions it needs.',
  WHATSAPP_SIGNUP_ASSET_UNVERIFIED:
    'Akeed could not confirm access to the WhatsApp account and number you chose.',
  WHATSAPP_SIGNUP_ASSET_AMBIGUOUS:
    'More than one WhatsApp account or number was shared. Start again and choose one.',
};

export function whatsappConnectError(
  code: WhatsappConnectErrorCode,
): HttpException {
  const status = STATUS[code];
  return new HttpException(
    {
      statusCode: status,
      error: HttpStatus[status],
      message: MESSAGES[code],
      code,
    },
    status,
  );
}
