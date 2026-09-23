import { hasCrossedCreditsWarning } from './product-events';

describe('hasCrossedCreditsWarning', () => {
  it.each([
    [23, 24, 30, true],
    [24, 25, 30, false],
    [22, 23, 30, false],
    [239, 240, 300, true],
    [0, 1, 0, false],
  ])(
    'from %i to %i of %i is %s',
    (consumedBefore, consumedAfter, includedLimit, expected) => {
      expect(
        hasCrossedCreditsWarning({
          consumedBefore,
          consumedAfter,
          includedLimit,
        }),
      ).toBe(expected);
    },
  );
});
