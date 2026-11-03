import type { WhatsappConnectionRecord } from '../../../database/repositories/whatsapp-connections.repository';
import {
  decryptToken,
  encryptToken,
} from '../../../../shared/utils/token-encryption.util';

/** The `v1:` envelope `encryptToken` writes: version, IV, tag, ciphertext. */
const ENVELOPE = /^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]*$/;

/** Encrypts a business token or registration PIN for storage. */
export function encryptConnectionSecret(
  plaintext: string,
  encryptionKey: string,
): string {
  if (!plaintext) throw new Error('Refusing to encrypt an empty secret');
  return encryptToken(plaintext, encryptionKey);
}

/**
 * The plaintext of a stored secret, or null when it holds none that can be
 * used.
 *
 * `decryptToken` hands back what it cannot parse as an envelope, so anything
 * that is not a well-formed `v1:` envelope is refused here before decrypting,
 * and a value that comes back unchanged or empty is refused after. A
 * plaintext or damaged value is never sent to Meta.
 */
function readConnectionSecret(
  stored: string | null,
  encryptionKey: string,
): string | null {
  if (!stored || !ENVELOPE.test(stored)) return null;
  try {
    const plaintext = decryptToken(stored, encryptionKey);
    return plaintext && plaintext !== stored ? plaintext : null;
  } catch {
    return null;
  }
}

/** The business token of a connection, or null when it holds no usable one. */
export function readBusinessToken(
  connection: Pick<WhatsappConnectionRecord, 'businessTokenEncrypted'>,
  encryptionKey: string,
): string | null {
  return readConnectionSecret(connection.businessTokenEncrypted, encryptionKey);
}

/** The registration PIN of a connection, or null when it holds no usable one. */
export function readRegistrationPin(
  connection: Pick<WhatsappConnectionRecord, 'registrationPinEncrypted'>,
  encryptionKey: string,
): string | null {
  return readConnectionSecret(
    connection.registrationPinEncrypted,
    encryptionKey,
  );
}
