import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CompleteRegistrationDto } from './complete-registration.dto';

const VALID = {
  eventId: '0b6f6a3c-3f1e-4a9b-9e0a-2a4f3c1d5e6f',
  userId: '11111111-1111-4111-8111-111111111111',
  eventSourceUrl: 'https://getakeed.com/ar/signup',
  fbp: 'fb.1.1700000000000.123',
};

function errorsFor(body: Record<string, unknown>): string[] {
  return validateSync(plainToInstance(CompleteRegistrationDto, body)).map(
    (error) => error.property,
  );
}

describe('CompleteRegistrationDto', () => {
  it('accepts what the signup page sends, local URLs included', () => {
    expect(errorsFor(VALID)).toEqual([]);
    expect(
      errorsFor({
        ...VALID,
        eventSourceUrl: 'http://localhost:3001/en/signup',
      }),
    ).toEqual([]);
  });

  it.each([
    ['eventId', 'has spaces'],
    ['eventId', 'x'.repeat(65)],
    ['userId', 'not-a-uuid'],
    ['eventSourceUrl', 'javascript:alert(1)'],
    ['fbc', 'x'.repeat(513)],
  ])('rejects a bad %s', (field, value) => {
    expect(errorsFor({ ...VALID, [field]: value })).toEqual([field]);
  });
});
