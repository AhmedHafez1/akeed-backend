import { followStoreTimezone } from './store-timezone.util';

describe('followStoreTimezone', () => {
  it('moves a store still on the default zone to the store zone', () => {
    expect(
      followStoreTimezone({
        saved: 'Asia/Riyadh',
        previousStoreTimezone: null,
        storeTimezone: 'Europe/Istanbul',
      }),
    ).toBe('Europe/Istanbul');
  });

  it('follows a store zone change while the saved zone is the old store zone', () => {
    expect(
      followStoreTimezone({
        saved: 'Africa/Cairo',
        previousStoreTimezone: 'Africa/Cairo',
        storeTimezone: 'Asia/Dubai',
      }),
    ).toBe('Asia/Dubai');
  });

  it('keeps a zone the merchant picked', () => {
    expect(
      followStoreTimezone({
        saved: 'Asia/Qatar',
        previousStoreTimezone: 'Africa/Cairo',
        storeTimezone: 'Africa/Cairo',
      }),
    ).toBeNull();
  });

  it('changes nothing when the saved zone is already the store zone', () => {
    expect(
      followStoreTimezone({
        saved: 'Asia/Riyadh',
        previousStoreTimezone: null,
        storeTimezone: 'Asia/Riyadh',
      }),
    ).toBeNull();
  });

  it('ignores a missing or unknown store zone', () => {
    expect(
      followStoreTimezone({
        saved: 'Asia/Riyadh',
        previousStoreTimezone: null,
        storeTimezone: undefined,
      }),
    ).toBeNull();
    expect(
      followStoreTimezone({
        saved: 'Asia/Riyadh',
        previousStoreTimezone: null,
        storeTimezone: 'Not/AZone',
      }),
    ).toBeNull();
  });
});
