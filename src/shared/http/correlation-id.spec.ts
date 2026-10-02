import { resolveCorrelationId } from './correlation-id';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('resolveCorrelationId', () => {
  it.each([
    'req-12345',
    'A1b2C3d4',
    '0f8fad5b-d9cb-469f-a165-70867728950e',
    'shop.orders_2026-10-02',
    'x'.repeat(64),
  ])('echoes the safe value %s', (value) => {
    expect(resolveCorrelationId(value)).toBe(value);
    expect(resolveCorrelationId([value, 'second-value'])).toBe(value);
  });

  it.each<[string, unknown]>([
    ['nothing', undefined],
    ['an empty value', ''],
    ['a short value', 'abc1234'],
    ['a long value', 'x'.repeat(65)],
    ['spaces', 'order 10023 now'],
    ['a line break', `abcdefgh${String.fromCharCode(10)}forged-line`],
    ['markup', '<script>alert(1)</script>'],
    ['a JSON fragment', '{"orgId":"other"}'],
    ['a phone number', '+201001234567'],
    ['an email address', 'mona@example.com'],
    ['a non-text value', 12345678],
    ['an empty list', []],
  ])('replaces %s with a generated id', (_case, value) => {
    const resolved = resolveCorrelationId(value);
    expect(resolved).toMatch(UUID);
    expect(resolved).not.toBe(value);
  });

  it('generates a different id each time', () => {
    expect(resolveCorrelationId(undefined)).not.toBe(
      resolveCorrelationId(undefined),
    );
  });
});
