import type { EasyOrdersConnection } from '../../database/repositories/easyorders-connections.repository';
import { decryptToken } from '../../../shared/utils/token-encryption.util';

/**
 * The API key of a connection, or null when it holds none that can be used: a
 * disconnected row, or a stored value that does not decrypt.
 *
 * `decryptToken` hands back what it cannot parse as an envelope, so a value
 * that comes back unchanged is stored text, not a key, and is never sent
 * anywhere.
 */
export function readEasyOrdersApiKey(
  connection: Pick<EasyOrdersConnection, 'apiKeyEncrypted'>,
  encryptionKey: string,
): string | null {
  const { apiKeyEncrypted } = connection;
  if (!apiKeyEncrypted) return null;
  try {
    const apiKey = decryptToken(apiKeyEncrypted, encryptionKey);
    return apiKey && apiKey !== apiKeyEncrypted ? apiKey : null;
  } catch {
    return null;
  }
}
