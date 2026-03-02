import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type BinaryLike,
} from 'crypto';

const ENCRYPTION_VERSION = 'v1';
const AES_256_GCM_ALGORITHM = 'aes-256-gcm';
const AES_256_KEY_SIZE = 32;
const GCM_IV_SIZE = 12;

function resolveEncryptionKey(rawKey: string): Buffer {
  const trimmedKey = rawKey.trim();

  if (/^[0-9a-fA-F]{64}$/.test(trimmedKey)) {
    return Buffer.from(trimmedKey, 'hex');
  }

  const base64Key = Buffer.from(trimmedKey, 'base64');
  if (base64Key.length === AES_256_KEY_SIZE) {
    return base64Key;
  }

  const utf8Key = Buffer.from(trimmedKey, 'utf8');
  if (utf8Key.length === AES_256_KEY_SIZE) {
    return utf8Key;
  }

  throw new Error(
    'Invalid SHOPIFY_TOKEN_ENCRYPTION_KEY: expected 32-byte utf8, 64-char hex, or base64-encoded 32-byte key',
  );
}

export function encryptToken(plaintext: string, rawKey: string): string {
  const key = resolveEncryptionKey(rawKey);
  const iv = randomBytes(GCM_IV_SIZE);
  const cipher = createCipheriv(AES_256_GCM_ALGORITHM, key as BinaryLike, iv);

  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintext, 'utf8')),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    ENCRYPTION_VERSION,
    iv.toString('base64url'),
    authTag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

export function decryptToken(payload: string, rawKey: string): string {
  const parts = payload.split(':');

  if (parts.length !== 4 || parts[0] !== ENCRYPTION_VERSION) {
    return payload;
  }

  const [, ivB64, authTagB64, ciphertextB64] = parts;
  const key = resolveEncryptionKey(rawKey);

  const iv = Buffer.from(ivB64, 'base64url');
  const authTag = Buffer.from(authTagB64, 'base64url');
  const ciphertext = Buffer.from(ciphertextB64, 'base64url');

  const decipher = createDecipheriv(
    AES_256_GCM_ALGORITHM,
    key as BinaryLike,
    iv,
  );
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return plaintext.toString('utf8');
}
