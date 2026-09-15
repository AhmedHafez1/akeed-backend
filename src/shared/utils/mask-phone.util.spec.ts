import { maskPhone } from './mask-phone.util';

describe('maskPhone', () => {
  it('keeps the country prefix and last three digits of international numbers', () => {
    expect(maskPhone('+966512345123')).toBe('+9665•••••123');
    expect(maskPhone('+20 101 234 5678')).toBe('+2010•••••678');
  });

  it('keeps fewer leading digits on shorter numbers', () => {
    expect(maskPhone('0512345678')).toBe('05•••••678');
  });

  it('fully masks numbers too short to partially reveal', () => {
    expect(maskPhone('+12345')).toBe('+•••••');
  });

  it('returns an empty string for empty input', () => {
    expect(maskPhone('')).toBe('');
    expect(maskPhone(null)).toBe('');
    expect(maskPhone('n/a')).toBe('');
  });
});
