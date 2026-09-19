import { generateShortCode } from './short-code';

describe('generateShortCode', () => {
  it('produces six Crockford base32 characters accepted by the column check', () => {
    for (let attempt = 0; attempt < 500; attempt++) {
      expect(generateShortCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
    }
  });

  it('maps bytes onto the alphabet without ambiguous letters', () => {
    expect(generateShortCode(() => Buffer.from([0, 9, 10, 18, 31, 32]))).toBe(
      '09AJZ0',
    );
  });
});
