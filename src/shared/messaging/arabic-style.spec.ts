import { arabicStyleForPhone } from './arabic-style';
import { isArabicPhoneNumber } from './template-language';

describe('arabicStyleForPhone (US-08-07d mapping)', () => {
  it.each([
    ['+201001234567', 'egyptian'],
    ['00201001234567', 'egyptian'],
    ['+966501234567', 'gulf'],
    ['+971501234567', 'gulf'],
    ['+97333123456', 'gulf'],
    ['+97433123456', 'gulf'],
    ['+96550123456', 'gulf'],
    ['+96891234567', 'gulf'],
    ['+962791234567', 'standard'],
    ['+9647701234567', 'standard'],
    ['+963931234567', 'standard'],
    ['+96171123456', 'standard'],
    ['+970591234567', 'standard'],
    ['+212612345678', 'standard'],
    ['+213551234567', 'standard'],
    ['+21620123456', 'standard'],
    ['+218911234567', 'standard'],
    ['+22236123456', 'standard'],
    ['+249912345678', 'standard'],
    ['+252612345678', 'standard'],
    ['+25377123456', 'standard'],
    ['+2693212345', 'standard'],
    ['+967711234567', 'standard'],
  ])('maps %s to %s', (phone, style) => {
    expect(isArabicPhoneNumber(phone)).toBe(true);
    expect(arabicStyleForPhone(phone)).toBe(style);
  });

  it('reads a number with no Arabic code, or none at all, as standard', () => {
    expect(arabicStyleForPhone('+14155550100')).toBe('standard');
    expect(arabicStyleForPhone('01001234567')).toBe('standard');
    expect(arabicStyleForPhone(null)).toBe('standard');
  });

  it('ignores spaces and dashes the way the language choice does', () => {
    expect(arabicStyleForPhone('+20 100-123 4567')).toBe('egyptian');
    expect(arabicStyleForPhone('+966 50 123 4567')).toBe('gulf');
  });
});
