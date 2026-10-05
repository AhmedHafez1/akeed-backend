import {
  isPermissionErrorCode,
  mapApiStatus,
  mapCategory,
  mapComponents,
  mapQuality,
  mapWebhookEvent,
  normalizeLanguageCode,
} from './meta-template.mapping';

describe('Meta template mapping', () => {
  it.each([
    ['APPROVED', 'approved'],
    ['IN_APPEAL', 'in_appeal'],
    ['PENDING', 'pending'],
    ['REJECTED', 'rejected'],
    ['PENDING_DELETION', 'pending_deletion'],
    ['DELETED', 'deleted'],
    ['DISABLED', 'disabled'],
    ['PAUSED', 'paused'],
    ['LIMIT_EXCEEDED', 'limit_exceeded'],
    ['ARCHIVED', 'archived'],
  ])('maps API status %s to %s', (meta, neutral) => {
    expect(mapApiStatus(meta)).toBe(neutral);
  });

  it.each([
    ['APPROVED', 'approved'],
    ['ARCHIVED', 'archived'],
    ['UNARCHIVED', 'unarchived'],
    ['DELETED', 'deleted'],
    ['DISABLED', 'disabled'],
    ['FLAGGED', 'flagged'],
    ['IN_APPEAL', 'in_appeal'],
    ['LIMIT_EXCEEDED', 'limit_exceeded'],
    ['LOCKED', 'locked'],
    ['PAUSED', 'paused'],
    ['PENDING', 'pending'],
    ['REINSTATED', 'reinstated'],
    ['PENDING_DELETION', 'pending_deletion'],
    ['REJECTED', 'rejected'],
  ])('maps webhook event %s to %s', (meta, neutral) => {
    expect(mapWebhookEvent(meta)).toBe(neutral);
  });

  it.each([
    ['UTILITY', 'utility'],
    ['MARKETING', 'marketing'],
    ['AUTHENTICATION', 'authentication'],
  ])('maps category %s to %s', (meta, neutral) => {
    expect(mapCategory(meta)).toBe(neutral);
  });

  it.each([
    ['GREEN', 'high'],
    ['YELLOW', 'medium'],
    ['RED', 'low'],
    ['UNKNOWN', 'pending'],
  ])('maps quality %s to %s', (meta, neutral) => {
    expect(mapQuality(meta)).toBe(neutral);
  });

  it('maps any value the record does not list to unknown', () => {
    for (const value of ['ACTIVE', 'approved', '', null, undefined, 7, {}]) {
      expect(mapApiStatus(value)).toBe('unknown');
      expect(mapWebhookEvent(value)).toBe('unknown');
      expect(mapCategory(value)).toBe('unknown');
      expect(mapQuality(value)).toBe('unknown');
    }
    expect(mapWebhookEvent('toString')).toBe('unknown');
    expect(mapQuality({ score: 'GREEN' })).toBe('unknown');
  });

  it('reads - and _ in a language code as the same character', () => {
    expect(normalizeLanguageCode('en-US')).toBe('en_US');
    expect(normalizeLanguageCode(' ar_EG ')).toBe('ar_EG');
  });

  it('treats 10 and 200 to 299 as permission codes, and nothing else', () => {
    expect([10, 200, 250, 299].every(isPermissionErrorCode)).toBe(true);
    expect([4, 100, 190, 300, 80007].some(isPermissionErrorCode)).toBe(false);
  });

  describe('components', () => {
    it('reads the creation syntax into a neutral snapshot', () => {
      expect(
        mapComponents([
          { type: 'HEADER', format: 'TEXT', text: 'Order' },
          { type: 'BODY', text: 'Hi {{customer}}' },
          { type: 'FOOTER', text: 'Akeed' },
          {
            type: 'BUTTONS',
            buttons: [
              { type: 'QUICK_REPLY', text: 'Yes' },
              { type: 'quick_reply', text: 'No' },
              { type: 'URL', text: 'Track', url: 'https://example.test' },
            ],
          },
        ]),
      ).toEqual({
        header: 'Order',
        body: 'Hi {{customer}}',
        footer: 'Akeed',
        buttons: [
          { kind: 'quick_reply', text: 'Yes' },
          { kind: 'quick_reply', text: 'No' },
          { kind: 'other', text: 'Track' },
        ],
      });
    });

    it.each([
      ['not a list', { body: 'x' }],
      ['no body', [{ type: 'FOOTER', text: 'x' }]],
      [
        'a media header',
        [
          { type: 'HEADER', format: 'IMAGE' },
          { type: 'BODY', text: 'x' },
        ],
      ],
      [
        'an unlisted component',
        [
          { type: 'CAROUSEL', text: 'x' },
          { type: 'BODY', text: 'x' },
        ],
      ],
      [
        'a button without text',
        [
          { type: 'BODY', text: 'x' },
          { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY' }] },
        ],
      ],
    ])(
      'reads %s as unknown rather than a partial snapshot',
      (_label, value) => {
        expect(mapComponents(value)).toEqual({ unknown: true });
      },
    );
  });
});
