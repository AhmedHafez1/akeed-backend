import { spareContradiction } from './standalone-billing-operations.policy';

describe('spareContradiction', () => {
  it.each([
    // net packs, open charges, spare
    [0, 0, 0],
    [1, 1, 1],
    [1, 2, 0],
    [3, 5, 1],
  ])(
    'accepts %i packs, %i open charges and spare %i',
    (netPacks, openCharges, spareCredit) => {
      expect(
        spareContradiction({ netPacks, openCharges, spareCredit }),
      ).toBeNull();
    },
  );

  it.each([
    [1, 1, 0, 1],
    [0, 0, 1, 0],
    // Three open charges on one pack is a spare of -1: always wrong.
    [1, 3, 0, -1],
    [2, 1, 1, 3],
  ])(
    'flags %i packs, %i open charges and spare %i (expected %i)',
    (netPacks, openCharges, spareCredit, expectedSpare) => {
      expect(
        spareContradiction({ netPacks, openCharges, spareCredit }),
      ).toEqual({ code: 'spare_credit_mismatch', expectedSpare, spareCredit });
    },
  );
});
