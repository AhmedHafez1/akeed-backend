import { adjustForQuietHours, isInsideQuietHours } from './quiet-hours.util';

describe('quiet-hours.util', () => {
  describe('disabled or malformed', () => {
    it('returns input unchanged when disabled', () => {
      const dueAt = new Date('2026-05-01T10:00:00.000Z');
      const result = adjustForQuietHours(dueAt, {
        enabled: false,
        start: '21:00',
        end: '09:00',
        timezone: 'Asia/Riyadh',
      });
      expect(result.toISOString()).toBe(dueAt.toISOString());
    });

    it('returns input unchanged when start is malformed', () => {
      const dueAt = new Date('2026-05-01T10:00:00.000Z');
      const result = adjustForQuietHours(dueAt, {
        enabled: true,
        start: '25:99',
        end: '09:00',
        timezone: 'Asia/Riyadh',
      });
      expect(result.toISOString()).toBe(dueAt.toISOString());
    });

    it('returns input unchanged when end is missing', () => {
      const dueAt = new Date('2026-05-01T10:00:00.000Z');
      const result = adjustForQuietHours(dueAt, {
        enabled: true,
        start: '21:00',
        end: null,
        timezone: 'Asia/Riyadh',
      });
      expect(result.toISOString()).toBe(dueAt.toISOString());
    });

    it('returns input unchanged when start equals end', () => {
      const dueAt = new Date('2026-05-01T10:00:00.000Z');
      const result = adjustForQuietHours(dueAt, {
        enabled: true,
        start: '21:00',
        end: '21:00',
        timezone: 'Asia/Riyadh',
      });
      expect(result.toISOString()).toBe(dueAt.toISOString());
    });

    it('falls back to default timezone when timezone is empty', () => {
      // 02:00 UTC == 05:00 Asia/Riyadh -> inside 21:00-09:00 quiet window.
      const dueAt = new Date('2026-05-01T02:00:00.000Z');
      const result = adjustForQuietHours(dueAt, {
        enabled: true,
        start: '21:00',
        end: '09:00',
        timezone: '',
      });
      // Should bump to 09:00 Asia/Riyadh on 2026-05-01 -> 06:00 UTC.
      expect(result.toISOString()).toBe('2026-05-01T06:00:00.000Z');
    });
  });

  describe('Asia/Riyadh (UTC+3)', () => {
    const tz = 'Asia/Riyadh';

    it('returns input unchanged when outside quiet window', () => {
      // 10:00 Riyadh on 2026-05-01 = 07:00 UTC.
      const dueAt = new Date('2026-05-01T07:00:00.000Z');
      const result = adjustForQuietHours(dueAt, {
        enabled: true,
        start: '21:00',
        end: '09:00',
        timezone: tz,
      });
      expect(result.toISOString()).toBe(dueAt.toISOString());
      expect(
        isInsideQuietHours(dueAt, {
          enabled: true,
          start: '21:00',
          end: '09:00',
          timezone: tz,
        }),
      ).toBe(false);
    });

    it('shifts to window end for early-morning portion of cross-midnight window', () => {
      // 06:00 Riyadh = 03:00 UTC; window 21:00-09:00; bumps to 09:00 Riyadh = 06:00 UTC.
      const dueAt = new Date('2026-05-01T03:00:00.000Z');
      const result = adjustForQuietHours(dueAt, {
        enabled: true,
        start: '21:00',
        end: '09:00',
        timezone: tz,
      });
      expect(result.toISOString()).toBe('2026-05-01T06:00:00.000Z');
    });

    it('shifts to next-day window end for evening portion of cross-midnight window', () => {
      // 22:30 Riyadh on 2026-05-01 = 19:30 UTC; bumps to 09:00 Riyadh on
      // 2026-05-02 = 06:00 UTC on 2026-05-02.
      const dueAt = new Date('2026-05-01T19:30:00.000Z');
      const result = adjustForQuietHours(dueAt, {
        enabled: true,
        start: '21:00',
        end: '09:00',
        timezone: tz,
      });
      expect(result.toISOString()).toBe('2026-05-02T06:00:00.000Z');
    });
  });

  describe('Africa/Cairo (UTC+2/+3 with DST consideration)', () => {
    const tz = 'Africa/Cairo';

    it('shifts same-day window when in window', () => {
      // Pick early afternoon. 13:30 Cairo on 2026-05-01.
      // Cairo is UTC+3 in May (DST), so 13:30 local == 10:30 UTC.
      const dueAt = new Date('2026-05-01T10:30:00.000Z');
      const result = adjustForQuietHours(dueAt, {
        enabled: true,
        start: '13:00',
        end: '15:00',
        timezone: tz,
      });
      // Bumps to 15:00 Cairo = 12:00 UTC.
      expect(result.toISOString()).toBe('2026-05-01T12:00:00.000Z');
    });
  });

  describe('Asia/Dubai (UTC+4)', () => {
    const tz = 'Asia/Dubai';

    it('does not shift when at the exact end boundary', () => {
      // 09:00 Dubai on 2026-05-01 = 05:00 UTC. Window end is exclusive.
      const dueAt = new Date('2026-05-01T05:00:00.000Z');
      const result = adjustForQuietHours(dueAt, {
        enabled: true,
        start: '22:00',
        end: '09:00',
        timezone: tz,
      });
      expect(result.toISOString()).toBe(dueAt.toISOString());
    });

    it('shifts when at the exact start boundary (cross-midnight)', () => {
      // 22:00 Dubai on 2026-05-01 = 18:00 UTC. Bumps to 09:00 Dubai next day = 05:00 UTC on 2026-05-02.
      const dueAt = new Date('2026-05-01T18:00:00.000Z');
      const result = adjustForQuietHours(dueAt, {
        enabled: true,
        start: '22:00',
        end: '09:00',
        timezone: tz,
      });
      expect(result.toISOString()).toBe('2026-05-02T05:00:00.000Z');
    });
  });

  describe('isInsideQuietHours', () => {
    it('returns false when disabled', () => {
      expect(
        isInsideQuietHours(new Date(), {
          enabled: false,
          start: '21:00',
          end: '09:00',
          timezone: 'Asia/Riyadh',
        }),
      ).toBe(false);
    });

    it('returns true inside same-day window', () => {
      // 14:00 Riyadh = 11:00 UTC.
      const inside = new Date('2026-05-01T11:00:00.000Z');
      expect(
        isInsideQuietHours(inside, {
          enabled: true,
          start: '13:00',
          end: '15:00',
          timezone: 'Asia/Riyadh',
        }),
      ).toBe(true);
    });

    it('returns false on unknown timezone (graceful)', () => {
      expect(
        isInsideQuietHours(new Date('2026-05-01T11:00:00.000Z'), {
          enabled: true,
          start: '00:00',
          end: '23:59',
          timezone: 'Mars/Olympus',
        }),
      ).toBe(false);
    });
  });
});
