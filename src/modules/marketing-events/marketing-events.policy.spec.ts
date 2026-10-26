import {
  buildCompleteRegistrationEvent,
  COMPLETE_REGISTRATION_WINDOW_MS,
  isRecentSignup,
  normalizeEmailForMeta,
  sha256Hex,
} from './marketing-events.policy';

describe('marketing-events policy', () => {
  const now = Date.parse('2026-10-26T12:00:00Z');

  it('normalises email the way Meta hashes it', () => {
    expect(normalizeEmailForMeta('  Sara@Example.COM ')).toBe(
      'sara@example.com',
    );
    expect(normalizeEmailForMeta('not-an-email')).toBeUndefined();
  });

  it('hashes with SHA-256 hex', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it.each([
    ['2026-10-26T11:50:00Z', true],
    ['2026-10-26T12:00:30Z', true],
    ['2026-10-26T11:44:00Z', false],
    ['2026-10-26T12:05:00Z', false],
    [undefined, false],
    ['garbage', false],
  ])('isRecentSignup(%s) is %s', (createdAt, expected) => {
    expect(isRecentSignup(createdAt, now)).toBe(expected);
  });

  it('keeps the window at fifteen minutes', () => {
    expect(COMPLETE_REGISTRATION_WINDOW_MS).toBe(15 * 60_000);
  });

  it('builds the CompleteRegistration event with hashed identifiers', () => {
    const event = buildCompleteRegistrationEvent({
      eventId: 'evt-1',
      eventSourceUrl: 'https://getakeed.com/ar/signup',
      userId: '11111111-1111-4111-8111-111111111111',
      email: ' Sara@Example.com',
      clientIp: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
      fbp: 'fb.1.1.2',
      fbc: 'fb.1.1.click',
      now,
    });

    expect(event).toEqual({
      event_name: 'CompleteRegistration',
      event_time: Math.floor(now / 1000),
      event_id: 'evt-1',
      event_source_url: 'https://getakeed.com/ar/signup',
      action_source: 'website',
      user_data: {
        em: [sha256Hex('sara@example.com')],
        external_id: [sha256Hex('11111111-1111-4111-8111-111111111111')],
        client_ip_address: '203.0.113.7',
        client_user_agent: 'Mozilla/5.0',
        fbp: 'fb.1.1.2',
        fbc: 'fb.1.1.click',
      },
    });
  });

  it('omits what it does not have', () => {
    const event = buildCompleteRegistrationEvent({
      eventId: 'evt-1',
      eventSourceUrl: 'https://getakeed.com/ar/signup',
      userId: 'u',
      now,
    });
    expect(event.user_data).toEqual({ external_id: [sha256Hex('u')] });
  });
});
