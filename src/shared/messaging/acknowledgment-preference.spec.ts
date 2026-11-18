import { acknowledgmentPreferenceUpdates } from './acknowledgment-preference';

describe('unified thank-you preference', () => {
  it('does not enable paid messages when the capability is unavailable', () => {
    expect(() => acknowledgmentPreferenceUpdates(false, true, false)).toThrow();
  });
  it('can always turn an existing opt-in off', () => {
    expect(acknowledgmentPreferenceUpdates(true, false, false)).toEqual({
      acknowledgmentEnabled: false,
    });
  });
  it('keeps the original consent time when an enabled preference is saved again', () => {
    expect(acknowledgmentPreferenceUpdates(true, true, true)).toEqual({
      acknowledgmentEnabled: true,
    });
  });
  it('records consent time only for a new opt-in', () => {
    const saved = acknowledgmentPreferenceUpdates(false, true, true);
    expect(saved.acknowledgmentEnabled).toBe(true);
    expect(typeof saved.acknowledgmentEnabledAt).toBe('string');
  });
});
