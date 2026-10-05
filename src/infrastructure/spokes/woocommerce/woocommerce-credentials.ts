import type { WooCommerceConnection } from '../../database/repositories/woocommerce-connections.repository';
import { decryptToken } from '../../../shared/utils/token-encryption.util';
import type { WooCommerceCredentials } from './woocommerce-api.client';

/**
 * The keys of a connection, or null when it holds none that can be used: a
 * disconnected row, or a stored value that does not decrypt.
 *
 * `decryptToken` hands back what it cannot parse as an envelope, so a value
 * that comes back unchanged is stored text, not a key, and is never sent
 * anywhere.
 */
export function readWooCommerceCredentials(
  connection: Pick<
    WooCommerceConnection,
    'consumerKeyEncrypted' | 'consumerSecretEncrypted'
  >,
  encryptionKey: string,
): WooCommerceCredentials | null {
  const { consumerKeyEncrypted, consumerSecretEncrypted } = connection;
  if (!consumerKeyEncrypted || !consumerSecretEncrypted) return null;
  try {
    const consumerKey = decryptToken(consumerKeyEncrypted, encryptionKey);
    const consumerSecret = decryptToken(consumerSecretEncrypted, encryptionKey);
    return consumerKey &&
      consumerSecret &&
      consumerKey !== consumerKeyEncrypted &&
      consumerSecret !== consumerSecretEncrypted
      ? { consumerKey, consumerSecret }
      : null;
  } catch {
    return null;
  }
}
