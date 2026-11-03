import { encryptToken } from '../../../../shared/utils/token-encryption.util';
import {
  encryptConnectionSecret,
  readBusinessToken,
  readRegistrationPin,
} from './whatsapp-connection-credentials';

const KEY = 'a'.repeat(64);
const OTHER_KEY = 'b'.repeat(64);

describe('WhatsApp connection credentials', () => {
  it('round-trips a business token and a PIN as v1 ciphertext', () => {
    const token = encryptConnectionSecret('EAAG-business-token', KEY);
    const pin = encryptConnectionSecret('123456', KEY);

    expect(token).toMatch(/^v1:/);
    expect(token).not.toContain('EAAG-business-token');
    expect(readBusinessToken({ businessTokenEncrypted: token }, KEY)).toBe(
      'EAAG-business-token',
    );
    expect(readRegistrationPin({ registrationPinEncrypted: pin }, KEY)).toBe(
      '123456',
    );
  });

  it('refuses to encrypt an empty secret', () => {
    expect(() => encryptConnectionSecret('', KEY)).toThrow();
  });

  it.each([
    ['nothing stored', null],
    ['an empty value', ''],
    ['plaintext', 'EAAG-plaintext-token'],
    ['a plaintext value that looks like a version', 'v1:EAAG'],
    ['too few envelope parts', 'v1:aaaa:bbbb'],
    ['too many envelope parts', 'v1:aaaa:bbbb:cccc:dddd'],
    ['another version', 'v2:aaaa:bbbb:cccc'],
    ['characters outside base64url', 'v1:aa aa:bbbb:cccc'],
    ['a damaged envelope', 'v1:AAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBBBBBBBB:CCCC'],
  ])('reads %s as no credential', (_case, stored) => {
    expect(readBusinessToken({ businessTokenEncrypted: stored }, KEY)).toBe(
      null,
    );
    expect(readRegistrationPin({ registrationPinEncrypted: stored }, KEY)).toBe(
      null,
    );
  });

  it('reads ciphertext under another key as no credential', () => {
    const token = encryptConnectionSecret('EAAG-business-token', OTHER_KEY);
    expect(readBusinessToken({ businessTokenEncrypted: token }, KEY)).toBe(
      null,
    );
  });

  it('reads an encrypted empty value as no credential', () => {
    const empty = encryptToken('', KEY);
    expect(readBusinessToken({ businessTokenEncrypted: empty }, KEY)).toBe(
      null,
    );
  });
});
