import {
  classifyDeliveryFailure,
  normalizeDeliveryErrorCode,
} from './delivery-failure.policy';

describe('classifyDeliveryFailure', () => {
  it.each([
    [131026, 'no_whatsapp'],
    ['131026', 'no_whatsapp'],
    [' 131026 ', 'no_whatsapp'],
    [131047, 'other'],
    [131049, 'other'],
    [131050, 'other'],
    [131021, 'other'],
    [130472, 'other'],
    ['1310260', 'other'],
    ['', 'other'],
    ['abc', 'other'],
    [Number.NaN, 'other'],
    [null, 'other'],
    [undefined, 'other'],
  ] as const)('classifies %p as %s', (code, expected) => {
    expect(classifyDeliveryFailure(code)).toBe(expected);
  });
});

describe('normalizeDeliveryErrorCode', () => {
  it.each([
    [131026, '131026'],
    [' 131026 ', '131026'],
    ['', null],
    ['  ', null],
    [Number.POSITIVE_INFINITY, null],
    [null, null],
    [undefined, null],
  ] as const)('stores %p as %p', (code, expected) => {
    expect(normalizeDeliveryErrorCode(code)).toBe(expected);
  });
});
